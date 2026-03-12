import test from 'node:test';
import assert from 'node:assert/strict';
import { isGeolocationDenialOrTimeout } from '../src/geolocation.js';

test('returns true for geolocation permission denial code', () => {
  assert.equal(isGeolocationDenialOrTimeout({ code: 1 }), true);
  assert.equal(isGeolocationDenialOrTimeout({ code: 'PERMISSION_DENIED' }), true);
});

test('returns true for geolocation timeout code', () => {
  assert.equal(isGeolocationDenialOrTimeout({ code: 3 }), true);
  assert.equal(isGeolocationDenialOrTimeout({ code: 'TIMEOUT' }), true);
});

test('returns false for position unavailable and non-geolocation errors', () => {
  assert.equal(isGeolocationDenialOrTimeout({ code: 2 }), false);
  assert.equal(isGeolocationDenialOrTimeout({ code: 'POSITION_UNAVAILABLE' }), false);
  assert.equal(isGeolocationDenialOrTimeout({}), false);
  assert.equal(isGeolocationDenialOrTimeout(null), false);
});
