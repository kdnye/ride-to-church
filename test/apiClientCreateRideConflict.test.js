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
  location: { hash: '' },
};

const { apiClient } = await import('../src/apiClient.js');

test('createRide surfaces a user-friendly conflict error for active ride uniqueness', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: 'Active ride already exists for that date' }),
  });

  await assert.rejects(
    apiClient.createRide({ memberId: 'member-1', scheduledFor: '2026-01-01' }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.message, 'Active ride already exists for that date');
      return true;
    },
  );
});
