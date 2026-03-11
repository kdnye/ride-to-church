import test from 'node:test';
import assert from 'node:assert/strict';

import { getNewlyAssignedRidesForPersistence } from '../src/autoAssignPersistence.js';

test('persists only rides returned by autoAssignRides assignments', () => {
  const rides = [
    { id: 'ride-existing', status: 'assigned', driverId: 'driver-1' },
    { id: 'ride-new', status: 'assigned', driverId: 'driver-2' },
    { id: 'ride-requested', status: 'requested', driverId: null },
  ];

  const assignments = [{ rideId: 'ride-new', driverId: 'driver-2' }];

  const ridesToPersist = getNewlyAssignedRidesForPersistence({ rides, assignments });

  assert.deepEqual(ridesToPersist.map((ride) => ride.id), ['ride-new']);
});

test('running auto-assign twice does not rewrite existing assignments', () => {
  const ridesAfterFirstAutoAssign = [
    { id: 'ride-1', status: 'assigned', driverId: 'driver-1' },
  ];

  const firstAssignments = [{ rideId: 'ride-1', driverId: 'driver-1' }];
  const secondAssignments = [];

  const firstRunRidesToPersist = getNewlyAssignedRidesForPersistence({
    rides: ridesAfterFirstAutoAssign,
    assignments: firstAssignments,
  });
  const secondRunRidesToPersist = getNewlyAssignedRidesForPersistence({
    rides: ridesAfterFirstAutoAssign,
    assignments: secondAssignments,
  });

  assert.deepEqual(firstRunRidesToPersist.map((ride) => ride.id), ['ride-1']);
  assert.deepEqual(secondRunRidesToPersist, []);
});
