import React, { useEffect, useRef, useState } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor } from '../../utils/colors';

/**
 * Floating "Picture-in-Picture" toast for live team-radio playback.
 *
 * Mounted once at the app root so it overlays every view (Pit Wall,
 * docked layouts, overlays). Owns the single <audio> element used for
 * autoplay so we never double-play the same clip from the Race Control
 * panel + this component simultaneously.
 *
 * Filter rules (decided here so the user gets implicit control by
 * clicking drivers in the leaderboard):
 *   - selectedDrivers non-empty   → only those drivers' radios play
 *   - else focusDriver set        → only the focus driver's radios play
 *   - else                        → nothing autoplays (the user hasn't
 *                                   told us who to follow). The Race
 *                                   Control panel still lets them play
 *                                   anything manually.
 *
 * Browser policy reminder: autoplay with sound only works once the user
 * has interacted with the page. The "Auto-play" toggle's onClick is a
 * gesture, so flipping it ON is enough on Chrome / Firefox / Edge. iOS
 * Safari can still refuse — we surface that with a "tap to enable"
 * banner inside the toast.
 */
export default function RadioPipToast() {
  const radioAutoplay = useF1Store((s) => s.radioAutoplay);
  const teamRadios    = useF1Store((s) => s.teamRadios || []);
  const selectedDrivers = useF1Store((s) => s.selectedDrivers || []);
  const focusDriver   = useF1Store((s) => s.focusDriver);
  const drivers       = useF1Store((s) => s.drivers || []);

  const audioRef = useRef(null);
  const queueRef = useRef([]);
  const seenUrlsRef = useRef(new Set());
  const isPlayingRef = useRef(false);
  const initialisedRef = useRef(false);

  const [current, setCurrent] = useState(null); // {audio_url, driver, transcript, ...}
  const [progress, setProgress] = useState(0);  // 0–1
  const [duration, setDuration] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const [muted, setMuted] = useState(false);

  // Resolve fresh transcript text for the currently-playing clip — the
  // store mutates teamRadios items in place when transcripts arrive, so
  // we look up the matching entry on every render.
  const liveCurrent = current
    ? teamRadios.find((r) => r.audio_url === current.audio_url) || current
    : null;

  /* ── First mount: mark every existing radio as "seen" so an old race
       doesn't blast 30 historical clips when autoplay flips ON. */
  useEffect(() => {
    if (initialisedRef.current) return;
    initialisedRef.current = true;
    for (const r of teamRadios) {
      if (r?.audio_url) seenUrlsRef.current.add(r.audio_url);
    }
  }, [teamRadios]);

  /* ── Build the per-driver allow-list. Memoised in a ref to avoid
       triggering the queue effect on every render. */
  const numberToAbbr = useRef({});
  numberToAbbr.current = {};
  for (const d of drivers) {
    const num = String(d.DriverNumber ?? d.driver_number ?? d.RacingNumber ?? '');
    if (num) numberToAbbr.current[num] = d.Abbreviation || d.abbreviation;
  }

  const isAllowed = (radio) => {
    const abbr = radio.driver || numberToAbbr.current[radio.driver_number] || '';
    if (!abbr) return false;
    if (selectedDrivers.length > 0) return selectedDrivers.includes(abbr);
    if (focusDriver) return abbr === focusDriver;
    return false;
  };

  /* ── Watch new radios; enqueue the matching ones. */
  useEffect(() => {
    if (!radioAutoplay) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    let appended = false;
    for (const r of teamRadios) {
      if (!r?.audio_url) continue;
      if (seenUrlsRef.current.has(r.audio_url)) continue;
      seenUrlsRef.current.add(r.audio_url);
      if (!isAllowed(r)) continue;
      queueRef.current.push(r);
      appended = true;
    }
    if (appended) playNext();
    // Re-run on radioAutoplay flip ON: if the queue has stuff already
    // (rare — only if we toggled ON during a play attempt that was
    // blocked), kick it off.
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamRadios, radioAutoplay, selectedDrivers, focusDriver]);

  const playNext = () => {
    if (isPlayingRef.current) return;
    const next = queueRef.current.shift();
    if (!next || !audioRef.current) return;
    isPlayingRef.current = true;
    setCurrent(next);
    setProgress(0);
    audioRef.current.src = next.audio_url;
    audioRef.current.muted = muted;
    const promise = audioRef.current.play();
    if (promise && typeof promise.then === 'function') {
      promise.catch(() => {
        // Browser refused autoplay — surface the banner. Leave the toast
        // visible so the user can tap it (= gesture) to resume.
        setBlocked(true);
        isPlayingRef.current = false;
      });
    }
  };

  const handleEnded = () => {
    isPlayingRef.current = false;
    // Hold the toast a moment so the user sees the transcript / driver
    // chip before it disappears, then move on.
    setTimeout(() => {
      if (queueRef.current.length > 0) {
        playNext();
      } else {
        setCurrent(null);
        setProgress(0);
      }
    }, 1500);
  };

  const handleTimeUpdate = () => {
    const el = audioRef.current;
    if (!el || !el.duration || !isFinite(el.duration)) return;
    setProgress(el.currentTime / el.duration);
    setDuration(el.duration);
  };

  const handleManualResume = () => {
    setBlocked(false);
    if (audioRef.current) {
      audioRef.current.play().catch(() => setBlocked(true));
    }
  };

  const dismiss = () => {
    if (audioRef.current) audioRef.current.pause();
    isPlayingRef.current = false;
    setCurrent(null);
    setProgress(0);
    queueRef.current = [];
  };

  /* ── Render ──────────────────────────────────────────────────────── */
  // Always mount the audio element so refs stay alive across toast
  // open/close cycles.
  const showToast = !!liveCurrent;
  const abbr = liveCurrent
    ? (liveCurrent.driver || numberToAbbr.current[liveCurrent.driver_number] || '???')
    : '';
  const color = abbr ? getDriverColor(abbr) : '#888';
  const transcript = liveCurrent?.transcript;
  const transcriptStatus = liveCurrent?.transcript_status;

  return (
    <>
      <audio
        ref={audioRef}
        onEnded={handleEnded}
        onError={handleEnded}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={handleTimeUpdate}
        preload="none"
        style={{ display: 'none' }}
      />

      {showToast && (
        <div
          role="region"
          aria-label="Live team radio"
          style={{
            position: 'fixed',
            top: 76,
            right: 20,
            zIndex: 1500,
            width: 340,
            maxWidth: 'calc(100vw - 40px)',
            background: 'rgba(12,12,28,0.92)',
            backdropFilter: 'blur(20px) saturate(1.6)',
            WebkitBackdropFilter: 'blur(20px) saturate(1.6)',
            border: `1px solid ${color}55`,
            borderLeft: `4px solid ${color}`,
            borderRadius: 8,
            boxShadow: '0 18px 36px -12px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)',
            color: '#e0e0e0',
            fontFamily: "'Titillium Web', 'Inter', sans-serif",
            overflow: 'hidden',
          }}
        >
          {/* Header strip */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '7px 10px',
            background: `linear-gradient(90deg, ${color}22 0%, transparent 70%)`,
            borderBottom: '1px solid rgba(255,255,255,0.05)',
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: '50%',
              background: '#e10600',
              boxShadow: '0 0 8px rgba(225,6,0,0.7)',
              animation: 'livePulse 1.2s ease-in-out infinite',
            }} />
            <span style={{
              fontSize: 9, fontWeight: 800, letterSpacing: '0.10em',
              textTransform: 'uppercase', color: '#fff',
            }}>Team Radio</span>

            <span style={{
              padding: '2px 7px', borderRadius: 3,
              background: `${color}30`, borderLeft: `3px solid ${color}`,
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 11, fontWeight: 800, color: '#fff',
              letterSpacing: '0.04em',
            }}>{abbr}</span>

            <span style={{ flex: 1 }} />

            <button
              type="button"
              onClick={() => {
                const next = !muted;
                setMuted(next);
                if (audioRef.current) audioRef.current.muted = next;
              }}
              title={muted ? 'Unmute' : 'Mute'}
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: muted ? '#f87171' : '#bbc',
                padding: 2,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2"
                   strokeLinecap="round" strokeLinejoin="round">
                {muted ? (
                  <>
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <line x1="23" y1="9" x2="17" y2="15" />
                    <line x1="17" y1="9" x2="23" y2="15" />
                  </>
                ) : (
                  <>
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                  </>
                )}
              </svg>
            </button>

            <button
              type="button"
              onClick={dismiss}
              title="Dismiss"
              style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#bbc', padding: 2,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2"
                   strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Body */}
          <div style={{ padding: '10px 12px 12px' }}>
            {blocked ? (
              <button
                type="button"
                onClick={handleManualResume}
                style={{
                  width: '100%', padding: '10px',
                  background: 'rgba(245,166,35,0.16)',
                  border: '1px solid #f5a62388',
                  borderRadius: 6,
                  color: '#f5a623',
                  fontSize: 11, fontWeight: 700,
                  letterSpacing: '0.06em', textTransform: 'uppercase',
                  cursor: 'pointer',
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                ▶ Tap to enable audio
              </button>
            ) : (
              <>
                {/* Progress bar (grows as audio plays) */}
                <div style={{
                  height: 3, borderRadius: 2,
                  background: 'rgba(255,255,255,0.06)',
                  overflow: 'hidden', marginBottom: 8,
                }}>
                  <div style={{
                    width: `${Math.min(100, Math.max(0, progress * 100))}%`,
                    height: '100%', background: color,
                    transition: 'width 0.1s linear',
                  }} />
                </div>

                {/* Transcript */}
                {transcriptStatus === 'queued' && (
                  <div style={{ fontSize: 10, color: '#888', fontStyle: 'italic' }}>
                    transcribing…
                  </div>
                )}
                {transcriptStatus === 'ok' && transcript && (
                  <div style={{
                    fontSize: 13, color: '#fff',
                    lineHeight: 1.4, fontStyle: 'italic',
                  }}>“{transcript}”</div>
                )}
                {(transcriptStatus === 'empty' || (transcriptStatus === 'ok' && !transcript)) && (
                  <div style={{ fontSize: 10, color: '#888' }}>(no speech detected)</div>
                )}
                {transcriptStatus === 'download_failed' && (
                  <div style={{ fontSize: 10, color: '#f87171' }}>transcript unavailable</div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
