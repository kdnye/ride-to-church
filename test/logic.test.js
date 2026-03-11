import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignRideWithVersionCheck,
  autoAssignRides,
  autoAssignRidesWithEvents,
  haversineDistanceKm,
  nearestDrivers,
  optimizeDriverQueue,
  queueForDriver,
  reorderQueueAtomicallyWithVersionCheck,
} from '../logic.js';

test('haversineDistanceKm returns 0 for identical points', () => {
  const d = haversineDistanceKm({ lat: 1, lon: 1 }, { lat: 1, lon: 1 });
  assert.equal(d, 0);
});

test('autoAssignRides assigns requested rides to approved drivers', () => {
  const users = [
    { id: 'm1', role: 'member', approval_status: 'approved', coordinates: { lat: 35, lon: -90 } },
    { id: 'd1', role: 'volunteer_driver', approval_status: 'approved', coordinates: { lat: 35.02, lon: -90 } },
  ];
  const rides = [{ id: 'r1', memberId: 'm1', status: 'requested' }];

  const assignments = autoAssignRides({ rides, users });

  assert.equal(assignments.length, 1);
  assert.equal(rides[0].status, 'assigned');
  assert.equal(rides[0].driverId, 'd1');
  assert.equal(rides[0].queueOrder, 1);
});

test('autoAssignRides respects maxRidesPerDriver', () => {
  const users = [
    { id: 'm1', role: 'member', approval_status: 'approved', coordinates: { lat: 35, lon: -90 } },
    { id: 'm2', role: 'member', approval_status: 'approved', coordinates: { lat: 35.01, lon: -90 } },
    { id: 'd1', role: 'volunteer_driver', approval_status: 'approved', coordinates: { lat: 35.02, lon: -90 } },
  ];
  const rides = [
    { id: 'r1', memberId: 'm1', status: 'requested' },
    { id: 'r2', memberId: 'm2', status: 'requested' },
  ];

  const assignments = autoAssignRides({ rides, users, maxRidesPerDriver: 1 });

  assert.equal(assignments.length, 1);
  assert.equal(rides[0].status, 'assigned');
  assert.equal(rides[1].status, 'requested');
});

test('queueForDriver returns only assigned rides sorted by queue order', () => {
  const users = [{ id: 'm1', fullName: 'M', coordinates: { lat: 0, lon: 0 } }];
  const rides = [
    { id: 'r1', memberId: 'm1', driverId: 'd1', status: 'assigned', queueOrder: 2 },
    { id: 'r2', memberId: 'm1', driverId: 'd1', status: 'assigned', queueOrder: 1 },
    { id: 'r3', memberId: 'm1', driverId: 'd2', status: 'assigned', queueOrder: 1 },
  ];

  const queue = queueForDriver('d1', rides, users);

  assert.deepEqual(queue.map((q) => q.id), ['r2', 'r1']);
});

test('autoAssignRidesWithEvents emits assignment and status events', () => {
  const users = [
    {
      id: 'm1',
      role: 'member',
      approval_status: 'approved',
      coordinates: { lat: 35, lon: -90 },
    },
    {
      id: 'd1',
      role: 'volunteer_driver',
      approval_status: 'approved',
      coordinates: { lat: 35.02, lon: -90 },
    },
  ];
  const rides = [{ id: 'r1', memberId: 'm1', status: 'requested', driverEtaMinutes: 10 }];

  const { assignments, emittedEvents } = autoAssignRidesWithEvents({ rides, users });

  assert.equal(assignments.length, 1);
  assert.equal(emittedEvents.length, 3);
  assert.deepEqual(emittedEvents.map((e) => e.type), [
    'ride.assigned',
    'ride.status_changed',
    'ride.driver_eta_10m',
  ]);
});

test('rejects stale assignment when two dispatchers assign same ride concurrently', () => {
  const rides = [{
    id: 'r1',
    status: 'requested',
    revision: 4,
    updatedAt: '2026-01-01T00:00:00.000Z',
    queueOrder: null,
    driverId: null,
  }];

  const first = assignRideWithVersionCheck({
    rides,
    rideId: 'r1',
    driverId: 'd1',
    expectedRevision: 4,
    expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    nowIso: '2026-01-01T00:01:00.000Z',
  });
  assert.equal(first.ok, true);

  const second = assignRideWithVersionCheck({
    rides,
    rideId: 'r1',
    driverId: 'd2',
    expectedRevision: 4,
    expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    nowIso: '2026-01-01T00:02:00.000Z',
  });

  assert.equal(second.ok, false);
  assert.equal(second.code, 'stale_ride_version');
  assert.equal(second.latestRide.driverId, 'd1');
});

test('atomic reorder updates all positions and rejects stale concurrent reorder', () => {
  const rides = [
    { id: 'r1', driverId: 'd1', status: 'assigned', queueOrder: 1, revision: 7, updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'r2', driverId: 'd1', status: 'assigned', queueOrder: 2, revision: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'r3', driverId: 'd1', status: 'assigned', queueOrder: 3, revision: 1, updatedAt: '2026-01-01T00:00:00.000Z' },
  ];

  const first = reorderQueueAtomicallyWithVersionCheck({
    rides,
    driverId: 'd1',
    rideId: 'r1',
    newPosition: 3,
    expectedRevision: 7,
    expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    nowIso: '2026-01-01T00:01:00.000Z',
  });

  assert.equal(first.ok, true);
  assert.deepEqual(first.queue, [
    { id: 'r2', queueOrder: 1 },
    { id: 'r3', queueOrder: 2 },
    { id: 'r1', queueOrder: 3 },
  ]);

  const second = reorderQueueAtomicallyWithVersionCheck({
    rides,
    driverId: 'd1',
    rideId: 'r1',
    newPosition: 1,
    expectedRevision: 7,
    expectedUpdatedAt: '2026-01-01T00:00:00.000Z',
    nowIso: '2026-01-01T00:02:00.000Z',
  });

  assert.equal(second.ok, false);
  assert.equal(second.code, 'stale_ride_version');
});


test('optimizeDriverQueue returns queue order for assigned rides only', () => {
  const queue = optimizeDriverQueue({
    driverCoordinates: { lat: 35, lon: -90 },
    rides: [
      {
        id: 'r1',
        status: 'assigned',
        scheduledFor: '2026-01-01T09:00:00Z',
        member: { coordinates: { lat: 35.01, lon: -90 } },
      },
      {
        id: 'r2',
        status: 'cancelled',
        scheduledFor: '2026-01-01T09:10:00Z',
        member: { coordinates: { lat: 36, lon: -90 } },
      },
      {
        id: 'r3',
        status: 'assigned',
        scheduledFor: '2026-01-01T09:20:00Z',
        member: { coordinates: { lat: 35.02, lon: -90 } },
      },
    ],
  });

  assert.deepEqual(queue.map((item) => item.id), ['r1', 'r3']);
  assert.deepEqual(queue.map((item) => item.queueOrder), [1, 2]);
});

test('optimizeDriverQueue prefers stops that satisfy tight pickup windows', () => {
  const queue = optimizeDriverQueue({
    driverCoordinates: { lat: 35, lon: -90 },
    rides: [
      {
        id: 'far-no-window',
        status: 'assigned',
        scheduledFor: '2026-01-01T09:00:00Z',
        wheelchairPickupBufferMinutes: 0,
        member: { coordinates: { lat: 35.2, lon: -90 } },
      },
      {
        id: 'near-tight-window',
        status: 'assigned',
        scheduledFor: '2026-01-01T09:00:00Z',
        pickupWindowEnd: '2026-01-01T09:10:00Z',
        wheelchairPickupBufferMinutes: 15,
        member: { coordinates: { lat: 35.01, lon: -90 } },
      },
      {
        id: 'near-flex',
        status: 'assigned',
        scheduledFor: '2026-01-01T09:00:00Z',
        pickupWindowStart: '2026-01-01T09:40:00Z',
        wheelchairPickupBufferMinutes: 0,
        member: { coordinates: { lat: 35.015, lon: -90 } },
      },
    ],
  });

  assert.equal(queue[0].id, 'near-tight-window');
});


test('nearestDrivers prioritizes matrix travel time before haversine distance', () => {
  const member = { id: 'm1', coordinates: { lat: 35, lon: -90 } };
  const drivers = [
    { id: 'd-near', coordinates: { lat: 35.001, lon: -90 } },
    { id: 'd-far-fast', coordinates: { lat: 35.03, lon: -90 } },
  ];

  const ranked = nearestDrivers(member, drivers, {}, {
    travelTimeSecondsByDriverId: {
      'd-near': 900,
      'd-far-fast': 420,
    },
  });

  assert.equal(ranked[0].id, 'd-far-fast');
});

test('optimizeDriverQueue can consume matrix-based travel lookup', () => {
  const queue = optimizeDriverQueue({
    driverCoordinates: { lat: 35, lon: -90 },
    rides: [
      {
        id: 'slow-by-matrix',
        status: 'assigned',
        scheduledFor: '2026-01-01T09:00:00Z',
        member: { coordinates: { lat: 35.01, lon: -90 } },
      },
      {
        id: 'fast-by-matrix',
        status: 'assigned',
        scheduledFor: '2026-01-01T09:00:00Z',
        member: { coordinates: { lat: 35.02, lon: -90 } },
      },
    ],
    travelTimeLookup(origin, destination) {
      if (!origin || !destination) return null;
      if (destination.lat === 35.01) return 2400;
      if (destination.lat === 35.02) return 300;
      return null;
    },
  });

  assert.equal(queue[0].id, 'fast-by-matrix');
});
