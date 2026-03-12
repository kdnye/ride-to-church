const GEOLOCATION_DENIED_CODES = new Set([1, 'PERMISSION_DENIED']);
const GEOLOCATION_TIMEOUT_CODES = new Set([3, 'TIMEOUT']);

export function isGeolocationDenialOrTimeout(error) {
  if (!error || typeof error !== 'object') return false;

  const { code } = error;
  return GEOLOCATION_DENIED_CODES.has(code) || GEOLOCATION_TIMEOUT_CODES.has(code);
}
