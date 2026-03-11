import test from 'node:test';
import assert from 'node:assert/strict';
import { canAccessDriverQueue } from '../src/authz.js';

test('volunteer driver can access own queue only', () => {
  assert.equal(canAccessDriverQueue({ userId: 'driver-1', role: 'volunteer_driver' }, 'driver-1'), true);
  assert.equal(canAccessDriverQueue({ userId: 'driver-1', role: 'volunteer_driver' }, 'driver-2'), false);
});

test('dispatcher, manager, and super_admin can access any queue', () => {
  for (const role of ['volunteer_dispatcher', 'people_manager', 'super_admin']) {
    assert.equal(canAccessDriverQueue({ userId: 'u-1', role }, 'driver-9'), true);
  }
});

test('returns false for missing session or requestedDriverId', () => {
  assert.equal(canAccessDriverQueue(null, 'driver-1'), false);
  assert.equal(canAccessDriverQueue({ userId: 'driver-1', role: 'volunteer_driver' }, ''), false);
});
