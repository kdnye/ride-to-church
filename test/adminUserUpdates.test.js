import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUserUpdates } from '../src/adminUserUpdates.js';

test('buildUserUpdates accepts null daily_ride_capacity to clear override', () => {
  const result = buildUserUpdates({ daily_ride_capacity: null });
  assert.deepEqual(result, { updates: { daily_ride_capacity: null } });
});

test('buildUserUpdates accepts positive integer daily_ride_capacity', () => {
  const result = buildUserUpdates({ daily_ride_capacity: 3 });
  assert.deepEqual(result, { updates: { daily_ride_capacity: 3 } });
});

test('buildUserUpdates rejects non-numeric daily_ride_capacity', () => {
  const result = buildUserUpdates({ daily_ride_capacity: '3' });
  assert.equal(result.error, 'daily_ride_capacity must be a positive integer or null');
});

test('buildUserUpdates rejects zero daily_ride_capacity', () => {
  const result = buildUserUpdates({ daily_ride_capacity: 0 });
  assert.equal(result.error, 'daily_ride_capacity must be a positive integer or null');
});

test('buildUserUpdates rejects negative daily_ride_capacity', () => {
  const result = buildUserUpdates({ daily_ride_capacity: -1 });
  assert.equal(result.error, 'daily_ride_capacity must be a positive integer or null');
});

test('buildUserUpdates includes all valid admin updates together', () => {
  const result = buildUserUpdates({
    role: 'volunteer_driver',
    approval_status: 'approved',
    daily_ride_capacity: 2,
  });

  assert.deepEqual(result, {
    updates: {
      role: 'volunteer_driver',
      approval_status: 'approved',
      daily_ride_capacity: 2,
    },
  });
});
