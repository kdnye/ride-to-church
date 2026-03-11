import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemberDriverTravelTimes } from '../src/services/routing/memberDriverTravelTimes.js';

function makePoint(lat, lon = -90) {
  return { lat, lon };
}

test('buildMemberDriverTravelTimes maps matrix indices back to member/driver ids and dedupes members', async () => {
  const users = [
    { id: 'd1', role: 'volunteer_driver', approval_status: 'approved', coordinates: makePoint(1) },
    { id: 'd2', role: 'volunteer_driver', approval_status: 'approved', coordinates: makePoint(2) },
    { id: 'm1', role: 'member', coordinates: makePoint(10) },
    { id: 'm2', role: 'member', coordinates: makePoint(20) },
  ];

  const rides = [
    { id: 'r1', memberId: 'm1', status: 'requested' },
    { id: 'r2', memberId: 'm1', status: 'requested' },
    { id: 'r3', memberId: 'm2', status: 'requested' },
  ];

  let callCount = 0;
  const travelTimes = await buildMemberDriverTravelTimes({
    rides,
    users,
    apiKey: 'fake-key',
    routeMatrixEnabled: true,
    getRouteMatrixDurationsSeconds: async ({ origins, destinations }) => {
      callCount += 1;
      const rows = [];
      origins.forEach((origin, originIndex) => {
        destinations.forEach((destination, destinationIndex) => {
          rows.push({
            originIndex,
            destinationIndex,
            durationSeconds: (origin.lat * 100) + destination.lat,
          });
        });
      });
      return rows;
    },
  });

  assert.equal(callCount, 1);
  assert.deepEqual(travelTimes, {
    m1: { d1: 110, d2: 210 },
    m2: { d1: 120, d2: 220 },
  });
});

test('buildMemberDriverTravelTimes chunks deterministically and preserves global index mapping', async () => {
  const users = [
    { id: 'd1', role: 'volunteer_driver', approval_status: 'approved', coordinates: makePoint(1) },
    { id: 'd2', role: 'volunteer_driver', approval_status: 'approved', coordinates: makePoint(2) },
    { id: 'd3', role: 'volunteer_driver', approval_status: 'approved', coordinates: makePoint(3) },
    { id: 'm1', role: 'member', coordinates: makePoint(10) },
    { id: 'm2', role: 'member', coordinates: makePoint(20) },
    { id: 'm3', role: 'member', coordinates: makePoint(30) },
  ];

  const rides = [
    { id: 'r1', memberId: 'm1', status: 'requested' },
    { id: 'r2', memberId: 'm2', status: 'requested' },
    { id: 'r3', memberId: 'm3', status: 'requested' },
  ];

  const calls = [];
  const travelTimes = await buildMemberDriverTravelTimes({
    rides,
    users,
    apiKey: 'fake-key',
    routeMatrixEnabled: true,
    limits: {
      maxOriginsPerRequest: 2,
      maxDestinationsPerRequest: 3,
      maxElementsPerRequest: 2,
    },
    getRouteMatrixDurationsSeconds: async ({ origins, destinations }) => {
      calls.push({
        originLats: origins.map((point) => point.lat),
        destinationLats: destinations.map((point) => point.lat),
      });

      return origins.flatMap((origin, originIndex) => destinations.map((destination, destinationIndex) => ({
        originIndex,
        destinationIndex,
        durationSeconds: (origin.lat * 100) + destination.lat,
      })));
    },
  });

  assert.deepEqual(calls, [
    { originLats: [1, 2], destinationLats: [10] },
    { originLats: [1, 2], destinationLats: [20] },
    { originLats: [1, 2], destinationLats: [30] },
    { originLats: [3], destinationLats: [10, 20] },
    { originLats: [3], destinationLats: [30] },
  ]);

  assert.deepEqual(travelTimes, {
    m1: { d1: 110, d2: 210, d3: 310 },
    m2: { d1: 120, d2: 220, d3: 320 },
    m3: { d1: 130, d2: 230, d3: 330 },
  });
});
