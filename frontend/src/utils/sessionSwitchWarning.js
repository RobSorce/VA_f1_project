/**
 * The confirmation the Session menu asks before loading another session
 * (H5 / V5.2): what the switch keeps and what it clears, read from the store
 * state.
 *
 * A load (store loadSession) keeps the open panels, the lap ranges (the
 * Timing Sheet's brush bar and the Position Tracker's brush), the PCA
 * selection (its analysis is asked again for the new session,
 * refetchDroppedPCA) and the focus driver. It clears the assistant's chat and
 * its scenario overlays (screenSwitchState), the Strategy Simulator plan and
 * result, the lap-time forecast (forecastReset) and the telemetry compare
 * laps. __tests__/sessionMenu.warning.test.js runs a real load and checks
 * both lists against it.
 *
 * Pure module: no React, no store access (the state is passed in).
 */

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const isRange = (r) => Array.isArray(r) && r.length === 2 && r.every((x) => Number.isFinite(x));

/**
 * @param {Object} s - store state
 * @returns {{kept: string[], cleared: string[]}} what a session load keeps and clears, as phrases
 */
export function sessionSwitchSummary(s) {
  const kept = [];
  const cleared = [];
  const overlays = s?.openOverlays?.length || 0;
  if (overlays > 0) kept.push(`${plural(overlays, 'open panel', 'open panels')}`);
  if (isRange(s?.selectedLapRange)) kept.push(`lap range ${s.selectedLapRange[0]}–${s.selectedLapRange[1]}`);
  if (isRange(s?.brushLapRange)) kept.push(`brushed laps ${s.brushLapRange[0]}–${s.brushLapRange[1]}`);
  const lasso = s?.selectedPCAPoints?.length || 0;
  if (lasso > 0) {
    kept.push(`${plural(lasso, 'lasso-selected point', 'lasso-selected points')} (analysis recomputed for the new session)`);
  }
  if (s?.focusDriver) kept.push(`focus on ${s.focusDriver}`);

  const messages = s?.geminiMessages?.length || 0;
  if (messages > 0) cleared.push(`the assistant chat (${plural(messages, 'message', 'messages')})`);
  const scenarios = s?.geminiOverlays?.length || 0;
  if (scenarios > 0) cleared.push(`${plural(scenarios, 'assistant scenario', 'assistant scenarios')} on the Strategy Timeline`);
  if (s?.simulatorStrategy || s?.simulatorResult) cleared.push('the Strategy Simulator plan');
  if (s?.lstmPredictions && Object.keys(s.lstmPredictions).length > 0) cleared.push('the lap-time forecast');
  const compareLaps = s?.telemetryCompareLaps?.length || 0;
  if (compareLaps > 0) cleared.push(`${plural(compareLaps, 'telemetry compare lap', 'telemetry compare laps')}`);
  return { kept, cleared };
}

/**
 * The text of the confirmation, or null when there is nothing to keep or
 * clear (the load then goes ahead without asking).
 *
 * @param {Object} s - store state
 * @returns {string|null}
 */
export function sessionSwitchMessage(s) {
  const { kept, cleared } = sessionSwitchSummary(s);
  if (!kept.length && !cleared.length) return null;
  const lines = ['Switch session?', ''];
  if (kept.length) lines.push(`Kept for the new session: ${kept.join(', ')}.`);
  if (cleared.length) lines.push(`Cleared: ${cleared.join(', ')}.`);
  lines.push('', 'Continue?');
  return lines.join('\n');
}
