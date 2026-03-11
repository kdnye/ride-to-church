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

test('getDriverQueue preserves solver output fields in queue payload', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      queue: [
        {
          id: 'ride-1',
          queueOrder: 1,
          travelTimeSeconds: 420,
          estimatedArrival: '2026-07-11T14:12:00.000Z',
          routePolyline: 'abc123',
          member: { id: 'member-1', fullName: 'Member One', coordinates: null },
        },
      ],
    }),
  });

  const queue = await apiClient.getDriverQueue('driver-1');
  assert.equal(queue[0].estimatedArrival, '2026-07-11T14:12:00.000Z');
  assert.equal(queue[0].routePolyline, 'abc123');
});

test('getDriverQueue normalizes missing solver output fields to null', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      queue: [{ id: 'ride-2', queueOrder: 2, member: { id: 'member-2', fullName: 'Member Two' } }],
    }),
  });

  const queue = await apiClient.getDriverQueue('driver-1');
  assert.equal(queue[0].estimatedArrival, null);
  assert.equal(queue[0].routePolyline, null);
});
