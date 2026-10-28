/**
 * Sector marks of the Circle of Doom: where the ends of sector 1 and sector 2
 * fall on a ring measured in seconds, and where the S1 / S2 / S3 / PIT labels
 * go on it.
 *
 * Sector fractions (sectorFractions). The ring's angle is time since the line
 * over the reference lap (circleOfDoom.js header), so a sector boundary is a
 * share of the lap TIME, not of its distance:
 *   f1  = median(S1 / LapTime)        (end of sector 1)
 *   f12 = median((S1 + S2) / LapTime) (end of sector 2)
 * over the laps the reference lap itself uses: every driver's laps in
 * referenceLap's window (refLap.laps) that are clean (circleOfDoom.isCleanLap:
 * green, no pit entry or exit, lap > 1, 0 < time < 200 s), completed at
 * sessionNow (Time <= now) and carry all three sector times
 * (Sector{k}TimeSeconds, else Sector{k}Time, as driverState.js reads them).
 * null below REF_MIN_SAMPLES such laps, so never on lap 1 (lap-1 laps are not
 * clean, and FastF1 gives lap 1 no sector-1 time). The circuit's own sector
 * split (circuit_info.track_coordinates[].Sector) is not used: it is a share
 * of distance, and it is cut on the race's fastest lap, which is not known
 * before that lap ends.
 *
 * Label placement (placeRingMarks). Angles are radians clockwise from the
 * top, as in circleOfDoom.js: anchor (cx + r sin a, cy - r cos a). Each label
 * is horizontal text centred on the circle of radius (rIn + rOut) / 2. S1, S2 and S3
 * start at the mid-angle of their sector and step outward (2 degrees, one
 * side then the other) while the label stays inside its sector; PIT starts
 * just before the start of the pit span (reserved[0]) and steps back, then
 * just after its end and steps on. A label takes the first angle where its
 * box lies radially between rIn and rOut, touches no reserved span and
 * overlaps no label already placed (LABEL_PAD apart); a label with no such
 * angle is dropped.
 *
 * Pure module: no React, no D3, no store access.
 */
import { isLapCompleted } from './raceTime';
import { referenceLap, isCleanLap, REF_MIN_SAMPLES } from './circleOfDoom';
import {
  polar, wrapAngle, textBox, LABEL_PAD,
} from './circleLabelLayout';

const TWO_PI = 2 * Math.PI;
/** Step of the label search, radians (2 degrees). */
export const MARK_STEP = Math.PI / 90;
/** How far PIT looks from the pit span on each side, radians (a quarter turn). */
export const PIT_MARK_REACH = Math.PI / 2;
/** Labels in placement order. */
export const RING_MARK_TEXTS = Object.freeze(['S1', 'S2', 'S3', 'PIT']);

function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normaliseNow(sessionNow) {
  return sessionNow == null || Number.isNaN(sessionNow) ? Infinity : sessionNow;
}

function median(values) {
  const a = [...values].sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  const mid = Math.floor(n / 2);
  return n % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

/** Sector k time of a row, seconds (Sector{k}TimeSeconds, else Sector{k}Time), or null. */
function sectorTime(lt, k) {
  const t = toNum(lt?.[`Sector${k}TimeSeconds`]) ?? toNum(lt?.[`Sector${k}Time`]);
  return t != null && t > 0 ? t : null;
}

/**
 * The per-lap sector shares sectorFractions takes the medians of (module
 * header): S1 / LapTime and (S1 + S2) / LapTime of every lap it uses.
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {Object|number} [refLap] - referenceLap result at the same sessionNow (its laps
 *   window is used); computed when it has no laps window
 * @param {number} [sessionNow=Infinity] - session seconds
 * @returns {{s1: Array<number>, s12: Array<number>, laps: [number, number]|null}}
 *   shares in (0, 1), one pair per lap, in row order
 */
export function sectorShares(lapTimes, refLap, sessionNow = Infinity) {
  const now = normaliseNow(sessionNow);
  const ref = Array.isArray(refLap?.laps) ? refLap : referenceLap(lapTimes, { sessionNow: now });
  if (!Array.isArray(ref?.laps)) return { s1: [], s12: [], laps: null };
  const [from, to] = ref.laps;
  const s1 = [];
  const s12 = [];
  for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
    const n = toNum(lt?.LapNumber);
    if (n == null || n < from || n > to || !isLapCompleted(lt, now) || !isCleanLap(lt)) continue;
    const a = sectorTime(lt, 1);
    const b = sectorTime(lt, 2);
    if (a == null || b == null || sectorTime(lt, 3) == null) continue;
    const lap = toNum(lt.LapTimeSeconds);
    s1.push(a / lap);
    s12.push((a + b) / lap);
  }
  return { s1, s12, laps: [from, to] };
}

/**
 * Sector boundaries as shares of the lap time at sessionNow (module header).
 *
 * @param {Array<Object>} lapTimes - sessionData.lap_times (full race)
 * @param {Object|number} [refLap] - referenceLap result at the same sessionNow (its laps
 *   window is used); computed when it has no laps window
 * @param {number} [sessionNow=Infinity] - session seconds
 * @returns {{f1: number, f12: number, n: number, laps: [number, number]}|null}
 *   f1, f12 in (0, 1); n = laps used; laps = the reference lap's window; null below
 *   REF_MIN_SAMPLES laps
 */
export function sectorFractions(lapTimes, refLap, sessionNow = Infinity) {
  const { s1, s12, laps } = sectorShares(lapTimes, refLap, sessionNow);
  if (s1.length < REF_MIN_SAMPLES) return null;
  return {
    f1: median(s1), f12: median(s12), n: s1.length, laps,
  };
}

/** Clockwise angle of point (x, y) seen from (cx, cy), in [0, 2 pi). */
function angleOf(cx, cy, x, y) {
  return wrapAngle(Math.atan2(x - cx, cy - y));
}

/** Signed angle a - b folded into [-pi, pi). */
function angleDiff(a, b) {
  return wrapAngle(a - b + Math.PI) - Math.PI;
}

/** Box of a label centred at angle a on radius r, with its angular extent [lo, hi] (lo may be < 0). */
function markBox(text, a, geo) {
  const [x, y] = polar(geo.cx, geo.cy, geo.r, a);
  const { w, h } = textBox([text], geo.fontPx, geo.measure);
  const box = {
    x0: x - w / 2, y0: y - h / 2, x1: x + w / 2, y1: y + h / 2,
  };
  const corners = [[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]];
  const offsets = corners.map(([px, py]) => angleDiff(angleOf(geo.cx, geo.cy, px, py), a));
  // Distance from the centre to the nearest point of the box, and to its farthest corner
  const nx = Math.min(Math.max(geo.cx, box.x0), box.x1) - geo.cx;
  const ny = Math.min(Math.max(geo.cy, box.y0), box.y1) - geo.cy;
  const far = Math.max(...corners.map(([px, py]) => Math.hypot(px - geo.cx, py - geo.cy)));
  return {
    x, y, box, lo: a + Math.min(...offsets), hi: a + Math.max(...offsets), near: Math.hypot(nx, ny), far,
  };
}

/** Do the arcs [s1, s1 + w1] and [s2, s2 + w2] (radians, w >= 0) meet? */
function arcsMeet(s1, w1, s2, w2) {
  return wrapAngle(s2 - s1) <= w1 || wrapAngle(s1 - s2) <= w2;
}

function boxesOverlap(a, b, pad) {
  return a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;
}

/** Reserved spans as { start, width }: [a0, a1] clockwise from a0 to a1. */
function spansOf(reserved) {
  return (Array.isArray(reserved) ? reserved : [])
    .filter((s) => Array.isArray(s) && toNum(s[0]) != null && toNum(s[1]) != null)
    .map(([a0, a1]) => {
      const width = a1 - a0;
      return { start: wrapAngle(a0), width: width >= 0 ? Math.min(width, TWO_PI) : wrapAngle(width) };
    });
}

/** Angles of a sector label: the mid-angle, then outward one step each side at a time, inside [lo, hi]. */
function sectorCandidates(lo, hi) {
  const mid = (lo + hi) / 2;
  const out = [mid];
  for (let k = 1; mid + k * MARK_STEP <= hi || mid - k * MARK_STEP >= lo; k++) {
    if (mid + k * MARK_STEP <= hi) out.push(mid + k * MARK_STEP);
    if (mid - k * MARK_STEP >= lo) out.push(mid - k * MARK_STEP);
  }
  return out;
}

/** Angles of the PIT label: back from the start of the pit span, then on from its end. */
function pitCandidates(span) {
  const out = [];
  for (let k = 1; k * MARK_STEP <= PIT_MARK_REACH; k++) out.push(span.start - k * MARK_STEP);
  for (let k = 1; k * MARK_STEP <= PIT_MARK_REACH; k++) out.push(span.start + span.width + k * MARK_STEP);
  return out;
}

/** True when sectors is [0, f1, f12, 1] with 0 <= f1 <= f12 <= 1. */
function validSectors(sectors) {
  if (!Array.isArray(sectors) || sectors.length !== 4) return false;
  const v = sectors.map(toNum);
  return v.every((x) => x != null && x >= 0 && x <= 1) && v[0] <= v[1] && v[1] <= v[2] && v[2] <= v[3];
}

/**
 * S1 / S2 / S3 / PIT labels on the ring (module header).
 *
 * @param {Object} p
 * @param {number} p.cx - ring centre, px
 * @param {number} p.cy - ring centre, px
 * @param {number} p.rIn - inner radius of the band the labels sit in, px
 * @param {number} p.rOut - outer radius, px
 * @param {Array<number>} [p.sectors] - [0, f1, f12, 1] as lap shares (sectorFractions);
 *   without them S1 to S3 are dropped
 * @param {Array<[number, number]>} [p.reserved] - angle spans [a0, a1] (radians, clockwise
 *   from a0 to a1) no label may touch; reserved[0] is the pit span PIT labels; without
 *   one PIT is dropped
 * @param {function(string, number): number} [p.measure] - text width in px at a font size
 *   (the view's measure); without it, the CHAR_EM estimate of circleLabelLayout.textBox
 * @param {number} p.fontPx - font size, px
 * @returns {Array<{text: string, angle: number, x: number, y: number,
 *   box: {x0: number, y0: number, x1: number, y1: number}}|{text: string, dropped: true}>}
 *   in RING_MARK_TEXTS order; x, y = the centre of the label box, px; angle in radians
 */
export function placeRingMarks({
  cx, cy, rIn, rOut, sectors, reserved = [], measure = null, fontPx,
}) {
  const geo = {
    cx, cy, r: (rIn + rOut) / 2, measure, fontPx,
  };
  const spans = spansOf(reserved);
  const placed = [];
  const fits = (m) => m.near >= rIn && m.far <= rOut
    && !spans.some((s) => arcsMeet(wrapAngle(m.lo), m.hi - m.lo, s.start, s.width))
    && !placed.some((p) => boxesOverlap(p.box, m.box, LABEL_PAD));
  const place = (text, candidates, inside = () => true) => {
    for (const a of candidates) {
      const m = markBox(text, a, geo);
      if (inside(m) && fits(m)) {
        const mark = {
          text, angle: wrapAngle(a), x: m.x, y: m.y, box: m.box,
        };
        placed.push(mark);
        return mark;
      }
    }
    return { text, dropped: true };
  };

  const out = [];
  const ok = validSectors(sectors);
  for (let k = 0; k < 3; k++) {
    const text = RING_MARK_TEXTS[k];
    if (!ok) {
      out.push({ text, dropped: true });
      continue;
    }
    const lo = TWO_PI * sectors[k];
    const hi = TWO_PI * sectors[k + 1];
    out.push(place(text, sectorCandidates(lo, hi), (m) => m.lo >= lo && m.hi <= hi));
  }
  out.push(spans.length ? place('PIT', pitCandidates(spans[0])) : { text: 'PIT', dropped: true });
  return out;
}
