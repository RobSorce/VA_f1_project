/**
 * Module Web Worker of the Monte Carlo race simulation.
 *
 * Message in:  { id, kind: 'project' | 'compare', params } (plain data; the lap
 *              table and track status may come as { $dataset, data? }
 *              references, see utils/simulationClient.js unpackParams)
 * Message out: { id, result } or { id, error }
 *
 * The jobs are utils/simulationClient.js runSimulationJob, the same code the
 * synchronous fallback runs on the main thread. Started by the store
 * (store/useF1Store.js) with new Worker(new URL(...), { type: 'module' }),
 * which Vite bundles as a separate file.
 */
import { runSimulationJob, unpackParams } from '../utils/simulationClient';

// The worker's copy of the large inputs, by field: { id, data }
const datasets = {};

/**
 * Run one job message and post its reply.
 *
 * @param {{id: number, kind: string, params: Object}} data
 * @param {function(Object)} post - postMessage
 */
export function handleJobMessage(data, post) {
  const { id, kind, params } = data || {};
  let reply;
  try {
    reply = { id, result: runSimulationJob(kind, unpackParams(params, datasets)) };
  } catch (e) {
    reply = { id, error: String(e?.message || e) };
  }
  post(reply);
}

// Installed only in a worker scope (no window); importing this module
// elsewhere (tests) installs nothing
if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof self.postMessage === 'function') {
  self.onmessage = (event) => handleJobMessage(event.data, (msg) => self.postMessage(msg));
}
