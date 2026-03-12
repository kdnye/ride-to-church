import test from 'node:test';
import assert from 'node:assert/strict';
import { getRouteMatrixDurationsSeconds } from '../src/services/routing/googleRoutesMatrix.js';
import { setTravelTimeSeconds } from '../src/services/routing/travelTimeCache.js';

test('getRouteMatrixDurationsSeconds parses XSSI-prefixed JSON array payloads', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    text: async () => ")]}'\n[{\"originIndex\":0,\"destinationIndex\":0,\"duration\":\"91s\",\"status\":{\"code\":0}}]",
  });

  try {
    const results = await getRouteMatrixDurationsSeconds({
      origins: [{ lat: 40.001, lon: -90.001 }],
      destinations: [{ lat: 41.001, lon: -91.001 }],
      apiKey: 'fake-key',
    });

    assert.deepEqual(results, [{ originIndex: 0, destinationIndex: 0, durationSeconds: 91 }]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getRouteMatrixDurationsSeconds ignores non-JSON lines in newline-delimited responses', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    text: async () => [
      'not-json',
      '{"originIndex":0,"destinationIndex":0,"duration":"120s","status":{"code":0}}',
      '{"originIndex":0,"destinationIndex":1,"duration":"130s","status":{"code":0}}',
    ].join('\n'),
  });

  try {
    const results = await getRouteMatrixDurationsSeconds({
      origins: [{ lat: 42.001, lon: -92.001 }],
      destinations: [{ lat: 43.001, lon: -93.001 }, { lat: 44.001, lon: -94.001 }],
      apiKey: 'fake-key',
    });

    assert.deepEqual(results, [
      { originIndex: 0, destinationIndex: 0, durationSeconds: 120 },
      { originIndex: 0, destinationIndex: 1, durationSeconds: 130 },
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test('getRouteMatrixDurationsSeconds keeps cached values when remote matrix fails', async () => {
  const origin = { lat: 45.001, lon: -95.001 };
  const destination = { lat: 46.001, lon: -96.001 };
  setTravelTimeSeconds(origin, destination, 77);

  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('network down');
  };

  try {
    const results = await getRouteMatrixDurationsSeconds({
      origins: [origin],
      destinations: [destination],
      apiKey: 'fake-key',
    });

    assert.deepEqual(results, [{ originIndex: 0, destinationIndex: 0, durationSeconds: 77 }]);
  } finally {
    global.fetch = originalFetch;
  }
});
