import { getTravelTimeSeconds, setTravelTimeSeconds } from './travelTimeCache.js';

const ROUTES_API_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const DEFAULT_TIMEOUT_MS = 8000;

function toWaypoint(point) {
  return {
    waypoint: {
      location: {
        latLng: {
          latitude: point.lat,
          longitude: point.lon,
        },
      },
    },
  };
}

function parseDurationSeconds(value) {
  if (typeof value !== 'string' || !value.endsWith('s')) return null;
  const seconds = Number(value.slice(0, -1));
  return Number.isFinite(seconds) ? seconds : null;
}

async function postMatrix({ origins, destinations, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(ROUTES_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,status',
      },
      body: JSON.stringify({
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
        origins: origins.map(toWaypoint),
        destinations: destinations.map(toWaypoint),
      }),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Google Route Matrix failed (${response.status}): ${text.slice(0, 240)}`);
    }

    const normalized = text.trim().replace(/^\)\]\}'\s*/, '');
    if (!normalized) return [];

    try {
      const parsed = JSON.parse(normalized);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return [parsed];
    } catch {
      // Fallback to newline-delimited parsing used by computeRouteMatrix.
    }

    const rows = [];
    for (const line of normalized
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        // Some providers prepend non-JSON lines; skip them and keep parsing.
      }
    }

    if (!rows.length) {
      throw new Error(`Google Route Matrix returned an unparseable payload: ${normalized.slice(0, 240)}`);
    }

    return rows;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getRouteMatrixDurationsSeconds({ origins, destinations, apiKey }) {
  if (!apiKey || !origins.length || !destinations.length) return [];

  const entries = [];
  let hasMissingCache = false;

  origins.forEach((origin, originIndex) => {
    destinations.forEach((destination, destinationIndex) => {
      const cached = getTravelTimeSeconds(origin, destination);
      if (Number.isFinite(cached)) {
        entries.push({ originIndex, destinationIndex, durationSeconds: cached });
      } else {
        hasMissingCache = true;
      }
    });
  });

  if (!hasMissingCache) return entries;

  let matrixRows = [];
  try {
    matrixRows = await postMatrix({ origins, destinations, apiKey });
  } catch (error) {
    console.warn('Route matrix request failed; continuing with cached travel times only.', error);
    return entries;
  }

  for (const row of matrixRows) {
    if (row?.status?.code && row.status.code !== 0) continue;
    const durationSeconds = parseDurationSeconds(row.duration);
    if (!Number.isFinite(durationSeconds)) continue;
    const origin = origins[row.originIndex];
    const destination = destinations[row.destinationIndex];
    if (!origin || !destination) continue;
    setTravelTimeSeconds(origin, destination, durationSeconds);
    entries.push({
      originIndex: row.originIndex,
      destinationIndex: row.destinationIndex,
      durationSeconds,
    });
  }

  return entries;
}
