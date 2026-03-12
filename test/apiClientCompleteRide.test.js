import test from 'node:test';
import assert from 'node:assert/strict';

const storage = new Map();

globalThis.window = {
  localStorage: {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
  },
};

const { apiClient } = await import('../src/apiClient.js');

test('completeRide calls complete endpoint and normalizes ride payload', async () => {
  let calledPath = null;
  let calledMethod = null;
  globalThis.fetch = async (url, options) => {
    calledPath = url;
    calledMethod = options?.method;
    return {
      ok: true,
      json: async () => ({
        ride: { id: 'ride-1' },
        rides: [{ id: 'ride-1' }],
      }),
    };
  };

  const response = await apiClient.completeRide('ride-1', {
    expectedRevision: 3,
    expectedUpdatedAt: '2026-01-01T10:00:00.000Z',
  });

  assert.equal(calledPath, '/api/rides/ride-1/complete');
  assert.equal(calledMethod, 'POST');
  assert.equal(response.ride.estimatedArrival, null);
  assert.equal(response.ride.routePolyline, null);
});
