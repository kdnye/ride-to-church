import test from 'node:test';
import assert from 'node:assert/strict';
import { autoAssignRides, haversineDistanceKm, queueForDriver } from '../logic.js';

test('haversineDistanceKm returns 0 for identical points', () => {
  const d = haversineDistanceKm({ lat: 1, lon: 1 }, { lat: 1, lon: 1 });
  assert.equal(d, 0);
});

test('autoAssignRides assigns requested rides to approved drivers', () => {
  const users = [
    { id: 'm1', role: 'member', status: 'approved', coordinates: { lat: 35, lon: -90 } },
    { id: 'd1', role: 'volunteer_driver', status: 'approved', coordinates: { lat: 35.02, lon: -90 } },
  ];
  const rides = [{ id: 'r1', memberId: 'm1', status: 'requested' }];

  const assignments = autoAssignRides({ rides, users });

  assert.equal(assignments.length, 1);
  assert.equal(rides[0].status, 'assigned');
  assert.equal(rides[0].driverId, 'd1');
  assert.equal(rides[0].queueOrder, 1);
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
