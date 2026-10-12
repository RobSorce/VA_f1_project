import React, { useMemo, useEffect } from 'react';
import { useF1Store } from '../../store/useF1Store';
import { getDriverColor } from '../../utils/colors';
import { useSessionNow } from '../../hooks/useSessionNow';
import { isLapCompleted } from '../../utils/raceTime';

function fmtSec(s) {
  if (s == null || !isFinite(s)) return '—';
  const sign = s >= 0 ? '+' : '-';
  return `${sign}${Math.abs(s).toFixed(3)}`;
}

/**
 * Running order at sessionNow (session seconds) from the laps completed by
 * then: more laps completed first, then the earlier line crossing (Time of
 * that lap). Drivers with no completed lap are left out.
 *
 * @param {Array<Object>} lapTimes
 * @param {number} sessionNow
 * @returns {string[]} driver codes, leader first
 */
export function runningOrderAt(lapTimes, sessionNow) {
  const last = {};
  for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
    if (!lt?.Driver || !isLapCompleted(lt, sessionNow)) continue;
    const cur = last[lt.Driver];
    if (!cur || lt.LapNumber > cur.LapNumber) last[lt.Driver] = lt;
  }
  const crossed = (lt) => (Number.isFinite(lt.Time) ? lt.Time : Infinity);
  const position = (lt) => (Number.isFinite(lt.Position) ? lt.Position : Infinity);
  return Object.values(last)
    .sort((a, b) => (b.LapNumber - a.LapNumber) || (crossed(a) - crossed(b))
      || (position(a) - position(b)) || a.Driver.localeCompare(b.Driver))
    .map((lt) => lt.Driver);
}

/**
 * Per-sector deltas focus - reference over the laps BOTH drivers completed at
 * sessionNow (session seconds), most recent first, at most `limit` laps. A lap
 * still running for either driver is left out, so no unfinished sector (e.g. an
 * in-lap's S3 through the pit lane) is shown before it is over.
 *
 * @param {Array<Object>} lapTimes
 * @param {string} focus
 * @param {string} ref
 * @param {number} sessionNow
 * @param {number} [limit=12]
 * @returns {Array<{lap: number, sectors: Array<number|null>, cumulative: number|null, lapDelta: number|null}>}
 */
export function sectorDeltaRows(lapTimes, focus, ref, sessionNow, limit = 12) {
  if (!focus || !ref || focus === ref) return [];
  const focusLaps = {};
  const refLaps = {};
  for (const lt of Array.isArray(lapTimes) ? lapTimes : []) {
    if (!isLapCompleted(lt, sessionNow)) continue;
    if (lt.Driver === focus) focusLaps[lt.LapNumber] = lt;
    if (lt.Driver === ref) refLaps[lt.LapNumber] = lt;
  }
  const laps = Object.keys(focusLaps)
    .map(Number)
    .filter((n) => refLaps[n])
    .sort((a, b) => b - a) // most recent first
    .slice(0, limit);

  return laps.map((lap) => {
    const f = focusLaps[lap];
    const r = refLaps[lap];
    const s = [1, 2, 3].map((si) => {
      const fv = f[`Sector${si}TimeSeconds`];
      const rv = r[`Sector${si}TimeSeconds`];
      if (!fv || !rv || fv <= 0 || rv <= 0 || fv > 300 || rv > 300) return null;
      return +(fv - rv).toFixed(3);
    });
    const deltas = s.map((v) => v || 0);
    const cumulative = [deltas[0], deltas[0] + deltas[1], deltas[0] + deltas[1] + deltas[2]];
    return {
      lap,
      sectors: s, // null if missing
      cumulative: s.every((v) => v != null) ? +cumulative[2].toFixed(3) : null,
      lapDelta: f.LapTimeSeconds && r.LapTimeSeconds
        ? +(f.LapTimeSeconds - r.LapTimeSeconds).toFixed(3)
        : null,
    };
  });
}

export default function SectorDeltaWaterfall() {
  const sessionData = useF1Store((s) => s.sessionData);
  const focusDriver = useF1Store((s) => s.focusDriver);
  const drivers = useF1Store((s) => s.drivers);
  const comparisonDriver = useF1Store((s) => s.comparisonDriver);
  const setComparisonDriver = useF1Store((s) => s.setComparisonDriver);
  // Causal "now" in session seconds (utils/raceTime.js): only laps completed
  // by then are compared
  const sessionNow = useSessionNow();

  const lapTimes = sessionData?.lap_times || [];

  const driverList = useMemo(() => {
    const set = new Set();
    for (const lt of lapTimes) if (lt.Driver) set.add(lt.Driver);
    return Array.from(set).sort();
  }, [lapTimes]);

  // Default focus to first driver if none selected
  const effectiveFocus = focusDriver || driverList[0] || null;

  // Default reference: driver ahead of focus in the running order at sessionNow
  const defaultRef = useMemo(() => {
    if (!effectiveFocus) return null;
    const order = runningOrderAt(lapTimes, sessionNow);
    const idx = order.indexOf(effectiveFocus);
    if (idx > 0) return order[idx - 1];
    if (order.length > 1) return order.find((d) => d !== effectiveFocus);
    return driverList.find((d) => d !== effectiveFocus) || null;
  }, [lapTimes, sessionNow, effectiveFocus, driverList]);

  // Use the shared comparison driver (synced with Undercut Calculator).
  // Fall back to the heuristic default (driver ahead of focus) when unset.
  const refDriver = (comparisonDriver && comparisonDriver !== effectiveFocus)
    ? comparisonDriver
    : defaultRef;

  // Seed the shared state on first render if no comparison is set yet,
  // so both panels start showing the same rival without user action.
  useEffect(() => {
    if (!comparisonDriver && defaultRef) {
      setComparisonDriver(defaultRef);
    }
  }, [comparisonDriver, defaultRef, setComparisonDriver]);

  // Laps both drivers completed at sessionNow (an unfinished lap is never compared)
  const rows = useMemo(
    () => sectorDeltaRows(lapTimes, effectiveFocus, refDriver, sessionNow),
    [lapTimes, effectiveFocus, refDriver, sessionNow],
  );

  // Normalize scale by the largest abs delta across all displayed sector cells
  const maxAbs = useMemo(() => {
    let m = 0.1;
    for (const r of rows) {
      for (const v of r.sectors) {
        if (v != null && Math.abs(v) > m) m = Math.abs(v);
      }
    }
    return m;
  }, [rows]);

  // Summary: mean per sector
  const summary = useMemo(() => {
    const sums = [0, 0, 0];
    const counts = [0, 0, 0];
    for (const r of rows) {
      r.sectors.forEach((v, i) => {
        if (v != null) { sums[i] += v; counts[i] += 1; }
      });
    }
    return sums.map((s, i) => (counts[i] ? +(s / counts[i]).toFixed(3) : null));
  }, [rows]);

  if (!effectiveFocus || !refDriver) {
    return (
      <div style={{ padding: 20, color: 'rgba(255,255,255,0.5)', fontSize: 11 }}>
        Select a focus driver and ensure at least two drivers have lap data.
      </div>
    );
  }

  const focusColor = getDriverColor(effectiveFocus);
  const refColor = getDriverColor(refDriver);

  const BAR_COL = 96;  // width of each sector bar column
  const LABEL_COL = 48;
  const CUM_COL = 70;
  const COL_GAP = 22;  // generous breathing room between columns

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, padding: '8px 10px', fontSize: 11 }}>
      {/* Header */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10 }}>FOCUS</span>
        <span style={{ fontWeight: 800, color: focusColor, fontSize: 12 }}>{effectiveFocus}</span>
        <span style={{ color: 'rgba(255,255,255,0.3)', fontSize: 10 }}>vs</span>
        <span style={{ color: 'rgba(255,255,255,0.5)', fontSize: 10 }}>REF</span>
        <select
          value={refDriver}
          onChange={(e) => setComparisonDriver(e.target.value)}
          style={{
            background: 'rgba(255,255,255,0.08)',
            color: refColor,
            border: `1px solid ${refColor}55`,
            borderRadius: 4,
            fontWeight: 800,
            fontSize: 11,
            padding: '2px 6px',
          }}
        >
          {driverList.filter((d) => d !== effectiveFocus).map((d) => (
            <option key={d} value={d} style={{ color: '#000' }}>{d}</option>
          ))}
        </select>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 9, color: 'rgba(255,255,255,0.55)' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: '#22c55e' }} />
            focus faster
          </span>
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 9, color: 'rgba(255,255,255,0.55)' }}>
            <span style={{ width: 10, height: 10, borderRadius: 2, background: '#ef4444' }} />
            focus slower
          </span>
        </span>
      </div>

      {/* Summary row (mean per sector) */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `${LABEL_COL}px repeat(3, ${BAR_COL}px) ${CUM_COL}px`,
        gap: COL_GAP,
        padding: '4px 0',
        borderBottom: '1px solid rgba(255,255,255,0.1)',
        marginBottom: 4,
        alignItems: 'center',
      }}>
        <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 9, fontWeight: 700 }}>AVG</span>
        {summary.map((v, i) => {
          const color = v == null ? 'rgba(255,255,255,0.3)' : v < 0 ? '#22c55e' : '#ef4444';
          return (
            <span key={i} style={{ color, fontWeight: 700, fontSize: 10, textAlign: 'center' }}>
              S{i + 1}: {v != null ? fmtSec(v) : '—'}
            </span>
          );
        })}
        <span style={{ color: 'rgba(255,255,255,0.4)', fontSize: 9, fontWeight: 700, textAlign: 'right' }}>Σ lap</span>
      </div>

      {/* Header row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `${LABEL_COL}px repeat(3, ${BAR_COL}px) ${CUM_COL}px`,
        gap: COL_GAP,
        fontSize: 9,
        color: 'rgba(255,255,255,0.4)',
        fontWeight: 700,
        letterSpacing: '0.05em',
        marginBottom: 2,
      }}>
        <span>LAP</span>
        <span style={{ textAlign: 'center' }}>S1 Δ</span>
        <span style={{ textAlign: 'center' }}>S2 Δ</span>
        <span style={{ textAlign: 'center' }}>S3 Δ</span>
        <span style={{ textAlign: 'right' }}>CUM</span>
      </div>

      {/* Waterfall rows */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {rows.map((r) => (
          <div
            key={r.lap}
            style={{
              display: 'grid',
              gridTemplateColumns: `${LABEL_COL}px repeat(3, ${BAR_COL}px) ${CUM_COL}px`,
              gap: 4,
              padding: '3px 0',
              borderBottom: '1px solid rgba(255,255,255,0.04)',
              alignItems: 'center',
            }}
          >
            <span style={{ color: 'rgba(255,255,255,0.7)', fontWeight: 700, fontSize: 10 }}>L{r.lap}</span>
            {r.sectors.map((v, i) => (
              <div key={i} style={{ position: 'relative', height: 16 }}>
                {/* center line */}
                <div style={{
                  position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1,
                  background: 'rgba(255,255,255,0.1)',
                }} />
                {v != null && (
                  <>
                    {/* Bar extending from center */}
                    <div style={{
                      position: 'absolute',
                      top: 2,
                      bottom: 2,
                      left: v < 0 ? `${50 - (Math.abs(v) / maxAbs) * 50}%` : '50%',
                      width: `${(Math.abs(v) / maxAbs) * 50}%`,
                      background: v < 0 ? '#22c55e' : '#ef4444',
                      borderRadius: 2,
                      opacity: 0.85,
                    }} />
                    {/* Numeric label sits on the OPPOSITE side of center from the
                        bar so it never lands on top of the colored fill. */}
                    <span style={{
                      position: 'absolute',
                      top: 0,
                      // v<0: bar on left → label on right (left:52%); v>0: bar on right → label on left (right:52%)
                      [v < 0 ? 'left' : 'right']: '52%',
                      fontSize: 10,
                      fontWeight: 700,
                      color: v < 0 ? '#22c55e' : '#ef4444',
                      lineHeight: '16px',
                      pointerEvents: 'none',
                      textShadow: '0 0 2px rgba(0,0,0,0.6)',
                      whiteSpace: 'nowrap',
                    }}>
                      {fmtSec(v)}
                    </span>
                  </>
                )}
                {v == null && (
                  <span style={{
                    position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)',
                    color: 'rgba(255,255,255,0.2)', fontSize: 9, lineHeight: '16px',
                  }}>—</span>
                )}
              </div>
            ))}
            <span style={{
              textAlign: 'right',
              fontWeight: 800,
              fontSize: 10,
              color: r.cumulative == null ? 'rgba(255,255,255,0.3)'
                : r.cumulative < 0 ? '#22c55e' : '#ef4444',
            }}>
              {r.cumulative != null ? fmtSec(r.cumulative) : '—'}
            </span>
          </div>
        ))}
        {rows.length === 0 && (
          <div style={{ padding: 16, textAlign: 'center', color: 'rgba(255,255,255,0.3)', fontSize: 10 }}>
            No overlapping laps yet between {effectiveFocus} and {refDriver}.
          </div>
        )}
      </div>
    </div>
  );
}
