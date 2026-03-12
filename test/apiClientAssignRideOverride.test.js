import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();

global.window = {
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  },
  location: { hash: '#/dispatch' },
};

const { apiClient } = await import('../src/apiClient.js');

test('assignRide forwards allowCapacityOverride and normalizes ride payloads', async () => {
  const calls = [];

  global.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ride: { id: 'ride-1', estimatedArrival: undefined, routePolyline: undefined },
        rides: [{ id: 'ride-1', estimatedArrival: undefined, routePolyline: undefined }],
      }),
    };
  };

  const response = await apiClient.assignRide('ride-1', {
    driverId: 'driver-1',
    expectedRevision: 8,
    allowCapacityOverride: true,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/rides/ride-1/assign');
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.allowCapacityOverride, true);
  assert.equal(body.driverId, 'driver-1');
  assert.equal(response.ride.estimatedArrival, null);
  assert.equal(response.ride.routePolyline, null);
});
