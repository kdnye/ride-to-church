import test from 'node:test';
import assert from 'node:assert/strict';
import {
  autoAssignRides,
  autoAssignRidesWithEvents,
  haversineDistanceKm,
  queueForDriver,
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
