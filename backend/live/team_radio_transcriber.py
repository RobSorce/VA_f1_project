"""
Team Radio Transcriber — async pipeline that downloads each .mp3 capture
from F1's static asset host and runs faster-whisper to produce a transcript.

Why faster-whisper over openai-whisper:
  - Same accuracy (CTranslate2 inference of the same OpenAI weights).
  - ~4x faster on CPU; supports int8 quantisation for an extra speedup.
  - No ffmpeg/torchaudio dependency — uses PyAV.

Why a queue + single worker (instead of one task per radio):
  - Whisper model load is slow (~10s); we want to load once and reuse.
  - F1 occasionally bursts 5-10 radios at session start; a queue keeps memory
    bounded and downloads/transcriptions sequential.

Honest limits (surfaced in the UI):
  - Driver radio audio is noisy (engines, wind, low-bitrate comms). Expect
    occasional garbled words; this is NOT a substitute for F1's broadcast captions.
  - English-only model (`*.en`) is faster + more accurate for the dominant
    case; non-English drivers get auto-detected by `language=None` runs but
    we keep `tiny.en` as a sensible default for an academic project.
"""
from __future__ import annotations

import asyncio
import io
import logging
import os
from typing import Awaitable, Callable, Optional

import aiohttp

logger = logging.getLogger(__name__)

# Default model. tiny.en is ~75 MB and runs ~real-time on CPU. Set the
# environment variable to upgrade ("base.en", "small.en", "medium.en")
# at the cost of more RAM and slower transcription.
WHISPER_MODEL = os.environ.get("VA_WHISPER_MODEL", "tiny.en")

# A single shared model instance, populated lazily.
_model = None
_model_lock = asyncio.Lock()


async def _load_model():
    """Load the Whisper model in a background thread so we don't block the loop."""
    global _model
    if _model is not None:
        return _model
    async with _model_lock:
        if _model is not None:
            return _model
        from faster_whisper import WhisperModel

        def _do_load():
            logger.info(f"Loading faster-whisper model '{WHISPER_MODEL}' (int8, CPU)...")
            return WhisperModel(WHISPER_MODEL, device="cpu", compute_type="int8")

        _model = await asyncio.to_thread(_do_load)
        logger.info("Whisper model loaded.")
    return _model


async def _download_audio(url: str, session: aiohttp.ClientSession, timeout: float = 15) -> Optional[bytes]:
    try:
        async with session.get(url, timeout=aiohttp.ClientTimeout(total=timeout)) as resp:
            if resp.status != 200:
                logger.warning(f"Radio download {resp.status} for {url}")
                return None
            return await resp.read()
    except Exception as e:
        logger.warning(f"Radio download failed for {url}: {e}")
        return None


async def _transcribe_bytes(audio_bytes: bytes) -> Optional[str]:
    """Run faster-whisper on an in-memory mp3, return concatenated text."""
    model = await _load_model()

    def _do_transcribe():
        # PyAV reads from a BytesIO stream — no temp file needed.
        bio = io.BytesIO(audio_bytes)
        segments, info = model.transcribe(
            bio,
            beam_size=1,           # greedy is fine for short clips
            vad_filter=True,       # skip silence/engine-only sections
            vad_parameters=dict(min_silence_duration_ms=500),
        )
        parts = []
        for seg in segments:
            text = (seg.text or "").strip()
            if text:
                parts.append(text)
        return " ".join(parts).strip()

    try:
        return await asyncio.to_thread(_do_transcribe)
    except Exception as e:
        logger.warning(f"Whisper failed: {e}")
        return None


class TeamRadioTranscriber:
    """
    Single-worker queue. Submit() enqueues a (radio_dict, on_done) tuple;
    the worker downloads the .mp3, transcribes it, mutates radio_dict in
    place to add a `transcript` field, and calls on_done(radio_dict).
    """

    def __init__(self):
        self._queue: asyncio.Queue = asyncio.Queue(maxsize=128)
        self._task: Optional[asyncio.Task] = None
        self._http: Optional[aiohttp.ClientSession] = None

    async def start(self):
        if self._task and not self._task.done():
            return
        self._http = aiohttp.ClientSession()
        self._task = asyncio.create_task(self._worker())
        logger.info("TeamRadioTranscriber worker started")

    async def stop(self):
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        if self._http:
            await self._http.close()
            self._http = None

    def submit(self, radio: dict, on_done: Callable[[dict], Awaitable[None]]):
        try:
            self._queue.put_nowait((radio, on_done))
        except asyncio.QueueFull:
            logger.warning("Transcription queue full — dropping a radio capture")

    async def _worker(self):
        while True:
            radio, on_done = await self._queue.get()
            url = radio.get("audio_url")
            if not url or self._http is None:
                continue
            audio = await _download_audio(url, self._http)
            if audio is None:
                radio["transcript"] = None
                radio["transcript_status"] = "download_failed"
            else:
                text = await _transcribe_bytes(audio)
                if text:
                    radio["transcript"] = text
                    radio["transcript_status"] = "ok"
                else:
                    radio["transcript"] = None
                    radio["transcript_status"] = "empty"
            try:
                await on_done(radio)
            except Exception as e:
                logger.warning(f"Transcript callback failed: {e}")
