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

test('updateUser includes daily_ride_capacity in PATCH body when provided', async () => {
  let fetchOptions;
  globalThis.fetch = async (_url, options) => {
    fetchOptions = options;
    return {
      ok: true,
      json: async () => ({ ok: true }),
    };
  };

  await apiClient.updateUser('user-1', { daily_ride_capacity: 5 });

  assert.equal(fetchOptions.method, 'PATCH');
  assert.deepEqual(JSON.parse(fetchOptions.body), { daily_ride_capacity: 5 });
});
