/**
 * URL of a file of frontend/public under the build's base: Vite's base is '/'
 * in development, './' in the normal build and the GitHub Pages path in the
 * demo build (vite.config.js). A root-relative '/f1-logo.png' ignores the base
 * and 404s on a Pages host (verifier V12,
 * notes/experiments/phase9/verify_cleanup-demo_r1/public_asset_paths.txt).
 *
 * @param {string} rel - path inside public/, with or without a leading '/'
 * @returns {string}
 */
const ENV = (typeof import.meta !== 'undefined' && import.meta.env) || {};

export function publicAsset(rel) {
  const base = ENV.BASE_URL || '/';
  return `${base.endsWith('/') ? base : `${base}/`}${String(rel).replace(/^\/+/, '')}`;
}
