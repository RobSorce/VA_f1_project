/**
 * Track Position Estimator
 *
 * Estimates driver x,y coordinates on the circuit from timing data when
 * live car position data is unavailable (paywalled since 2025 Dutch GP).
 *
 * Uses: sector completion + speed to estimate distance around lap,
 * then interpolates x,y from the static track_coordinates array.
 */

/**
 * Build a lookup table from distance → {x, y} from circuit track coordinates.
 * @param {Array} trackCoords - Array of {X, Y, Distance} from circuitInfo
 * @returns {Array} Sorted array of {distance, x, y}
 */
function buildTrackLookup(trackCoords) {
  if (!trackCoords?.length) return null;
  return trackCoords
    .filter((p) => p.X != null && p.Y != null && p.Distance != null)
    .map((p) => ({ distance: p.Distance, x: p.X, y: p.Y }))
    .sort((a, b) => a.distance - b.distance);
}

/**
 * Interpolate x,y from track lookup at a given distance.
 */
function interpolatePosition(lookup, distance) {
  if (!lookup?.length) return null;
  const totalDist = lookup[lookup.length - 1].distance;
  // Wrap around the track
  const d = ((distance % totalDist) + totalDist) % totalDist;

  // Binary search for the segment
  let lo = 0;
  let hi = lookup.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (lookup[mid].distance <= d) lo = mid;
    else hi = mid;
  }

  const p0 = lookup[lo];
  const p1 = lookup[hi];
  const segLen = p1.distance - p0.distance;
  const t = segLen > 0 ? (d - p0.distance) / segLen : 0;

  return {
    x: p0.x + (p1.x - p0.x) * t,
    y: p0.y + (p1.y - p0.y) * t,
  };
}

/**
 * Estimate driver positions from live timing data.
 *
 * @param {Array} trackCoords - circuitInfo.track_coordinates
 * @param {Object} driverStates - Map of abbreviation → { position, speed, sector1Done, sector2Done, sector3Done, lapProgress }
 * @param {number} totalDistance - Total track distance in meters
 * @returns {Object} Map of abbreviation → {x, y, estimated: true}
 */
export function estimateTrackPositions(trackCoords, driverStates, totalDistance) {
  const lookup = buildTrackLookup(trackCoords);
  if (!lookup) return {};

  const trackLength = totalDistance || lookup[lookup.length - 1].distance;
  const result = {};

  for (const [abbr, state] of Object.entries(driverStates)) {
    // Estimate distance around lap from sector completion
    let estimatedDistance = 0;

    if (state.lapProgress != null) {
      // Direct progress fraction (0–1)
      estimatedDistance = state.lapProgress * trackLength;
    } else {
      // Estimate from sectors (each sector ≈ 1/3 of track)
      const sectorFrac = (state.sector1Done ? 1 : 0) +
                          (state.sector2Done ? 1 : 0) +
                          (state.sector3Done ? 1 : 0);
      estimatedDistance = (sectorFrac / 3) * trackLength;

      // Refine with speed if available (assume ~1s since last update)
      if (state.speed > 0 && sectorFrac < 3) {
        // speed is in km/h, convert to m/s, assume ~0.5s since sector boundary
        estimatedDistance += (state.speed / 3.6) * 0.5;
      }
    }

    const pos = interpolatePosition(lookup, estimatedDistance);
    if (pos) {
      result[abbr] = { ...pos, estimated: true };
    }
  }

  return result;
}

/**
 * Estimate positions from frame data when x,y are null.
 * Uses position order to spread drivers evenly around the track as fallback.
 *
 * @param {Array} trackCoords - circuitInfo.track_coordinates
 * @param {Object} frameDrivers - frame.drivers map {ABBR: {x, y, position, speed, ...}}
 * @returns {Object} Map of ABBR → {x, y, estimated: true}
 */
export function estimateFromFramePositions(trackCoords, frameDrivers) {
  const lookup = buildTrackLookup(trackCoords);
  if (!lookup) return {};

  const trackLength = lookup[lookup.length - 1].distance;
  const result = {};

  // Sort drivers by position
  const sorted = Object.entries(frameDrivers)
    .filter(([, d]) => d.position > 0)
    .sort(([, a], [, b]) => a.position - b.position);

  const totalDrivers = sorted.length;
  if (totalDrivers === 0) return {};

  // Spread drivers around the track proportionally to gap
  // Use gap_to_leader to estimate relative positions
  const leaderDist = trackLength * 0.8; // Put leader at ~80% of track
  for (let i = 0; i < sorted.length; i++) {
    const [abbr, driver] = sorted[i];
    let dist;

    if (driver.gap_to_leader != null && driver.gap_to_leader > 0 && driver.speed > 0) {
      // Convert time gap to distance gap
      const gapMeters = (driver.gap_to_leader * driver.speed) / 3.6;
      dist = leaderDist - gapMeters;
    } else {
      // Evenly space by position
      const spacing = trackLength / (totalDrivers + 1);
      dist = leaderDist - i * spacing * 0.3;
    }

    // Ensure positive and wrap
    dist = ((dist % trackLength) + trackLength) % trackLength;
    const pos = interpolatePosition(lookup, dist);
    if (pos) {
      result[abbr] = { ...pos, estimated: true };
    }
  }

  return result;
}
