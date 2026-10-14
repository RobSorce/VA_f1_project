/**
 * Counter-based pseudo-random numbers for the Monte Carlo race simulation.
 *
 * Every draw is a pure function of its index (seed, sim, driver, lap, stream,
 * k): no generator state is carried from one draw to the next. Two runs with
 * the same seed therefore see the same number at the same index whatever
 * else they draw, which gives common random numbers for free: a what-if plan
 * that changes one driver's stops leaves every other draw untouched (the
 * other drivers' lap noise, the safety-car laps, ...). Changing the order in
 * which the simulation asks for draws never changes them either.
 *
 * Construction: each index field is absorbed in turn by xor-ing it into a
 * 32-bit state and applying an invertible integer finaliser (xorshift and
 * odd-constant multiply rounds). The finaliser is a bijection on 32-bit
 * words, so two indices that differ in exactly one field never collide at
 * that step. A uniform in (0, 1) takes 53 bits from two finalisations of the
 * final state. src/utils/__tests__/raceSimulation.prng.test.js checks the
 * uniformity, the normal moments and the independence of neighbouring
 * indices empirically.
 *
 * Driver codes are hashed (FNV-1a, keyOf) so a driver's draws do not depend
 * on its index in a list: adding or removing a driver shifts nothing.
 *
 * Pure module: no React, no D3, no store access; safe in a Web Worker.
 */

/** Stream ids: one per kind of random quantity in the simulation. */
export const STREAMS = Object.freeze({
  LAP_NOISE: 1,
  PIT_LOSS: 2,
  STINT_LIFE: 3,
  DEGRADATION: 4,
  SC_START: 5,
  SC_DURATION: 6,
  SC_TYPE: 7,
  STOP_DECISION: 8,
});

/** Invertible 32-bit integer finaliser (xorshift / multiply rounds). */
function fmix(x) {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Absorb one 32-bit field into the state. */
function absorb(h, v) {
  return fmix((h ^ (v >>> 0)) + 0x9e3779b9);
}

/**
 * 32-bit FNV-1a hash of a string: the numeric key of a driver code (or of any
 * other label used as an index).
 *
 * @param {string} str
 * @returns {number} uint32
 */
export function keyOf(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * A uint32 seed from any mix of numbers and strings (e.g. a session key and a
 * clock). Numbers are absorbed by their integer and fractional parts
 * (millisecond resolution), strings by keyOf. Infinity and NaN have their own
 * fixed codes, so seedFrom('2024_16', Infinity) is a valid seed.
 *
 * @param {...(number|string)} parts
 * @returns {number} uint32
 */
export function seedFrom(...parts) {
  let h = 0x2545f491;
  for (const p of parts) {
    if (typeof p === 'number') {
      if (Number.isNaN(p)) h = absorb(h, 0x7fc00000);
      else if (!Number.isFinite(p)) h = absorb(h, p > 0 ? 0x7f800000 : 0xff800000);
      else {
        const ms = Math.round(p * 1000);
        h = absorb(h, ms % 4294967296);
        h = absorb(h, Math.floor(ms / 4294967296));
      }
    } else {
      h = absorb(h, keyOf(p));
    }
  }
  return h;
}

/** Driver field: a uint32 as is, anything else through keyOf. */
function driverKey(driver) {
  return typeof driver === 'number' ? driver >>> 0 : keyOf(driver);
}

/**
 * Uniform draw in the open interval (0, 1) at index (seed, sim, driver, lap,
 * stream, k). 53 random bits; never exactly 0 or 1.
 *
 * @param {number} seed - uint32 (seedFrom)
 * @param {number} sim - simulation number
 * @param {string|number} driver - driver code (hashed) or a uint32 key
 * @param {number} lap - race lap (or another integer slot, e.g. a stint ordinal)
 * @param {number} stream - STREAMS value
 * @param {number} [k=0] - sub-index for several draws at the same index
 * @returns {number}
 */
export function uniformAt(seed, sim, driver, lap, stream, k = 0) {
  let h = absorb(seed >>> 0, sim);
  h = absorb(h, driverKey(driver));
  h = absorb(h, lap | 0);
  h = absorb(h, stream);
  h = absorb(h, k);
  const hi = h >>> 5; // 27 bits
  const lo = fmix(h ^ 0x5bd1e995) >>> 6; // 26 bits
  return (hi * 67108864 + lo + 0.5) / 9007199254740992;
}

/**
 * Standard normal draw at index (seed, sim, driver, lap, stream): Box-Muller
 * on the uniforms at sub-indices 0 and 1.
 *
 * @returns {number}
 */
export function normalAt(seed, sim, driver, lap, stream) {
  const u1 = uniformAt(seed, sim, driver, lap, stream, 0);
  const u2 = uniformAt(seed, sim, driver, lap, stream, 1);
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}
