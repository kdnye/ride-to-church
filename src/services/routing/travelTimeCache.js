const DEFAULT_TTL_MS = 1000 * 60 * 60 * 3;

const cache = new Map();

function normalizePoint(point) {
  if (!point) return null;
  const lat = Number(point.lat);
  const lon = Number(point.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    lat: Number(lat.toFixed(5)),
    lon: Number(lon.toFixed(5)),
  };
}

function keyFor(origin, destination) {
  const a = normalizePoint(origin);
  const b = normalizePoint(destination);
  if (!a || !b) return null;
  return `${a.lat},${a.lon}->${b.lat},${b.lon}`;
}

export function getTravelTimeSeconds(origin, destination) {
  const key = keyFor(origin, destination);
  if (!key) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

export function setTravelTimeSeconds(origin, destination, seconds, ttlMs = DEFAULT_TTL_MS) {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  const key = keyFor(origin, destination);
  if (!key) return;
  cache.set(key, {
    value: Math.round(seconds),
    expiresAt: Date.now() + Math.max(1000, ttlMs),
  });
}

export function buildTravelTimeLookup() {
  return (origin, destination) => getTravelTimeSeconds(origin, destination);
}
