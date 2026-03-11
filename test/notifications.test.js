import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEventBus,
  createGuardedEmailChannel,
  createNotificationEventHandler,
  createSmsChannel,
} from '../src/services/notifications/index.js';

test('createGuardedEmailChannel blocks non-postmark provider', () => {
  assert.throws(() => createGuardedEmailChannel({ provider: 'smtp' }), /Postmark/);
});

test('createNotificationEventHandler enforces postmark email wrapper', () => {
  assert.throws(
    () => createNotificationEventHandler({ emailChannel: { kind: 'email', provider: 'smtp' } }),
    /Postmark email channel wrapper/,
  );
});

test('notification handler sends member email, dispatcher summary, and sms', async () => {
  const emailSends = [];
  const smsSends = [];

  const handler = createNotificationEventHandler({
    emailChannel: {
      kind: 'email',
      provider: 'postmark',
      async send(payload) {
        emailSends.push(payload);
        return { ok: true };
      },
    },
    smsChannel: {
      kind: 'sms',
      provider: 'queue',
      async send(payload) {
        smsSends.push(payload);
        return { queued: true };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  await handler.handle(
    {
      type: 'ride.assigned',
      ride: { id: 'ride-1', memberId: 'member-1', driverId: 'driver-1', status: 'assigned' },
    },
    {
      users: [
        { id: 'member-1', fullName: 'Member One', email: 'member@example.com', phone: '+15551230001' },
        { id: 'driver-1', fullName: 'Driver One', email: 'driver@example.com' },
      ],
      fromEmail: 'dispatch@example.com',
      dispatcherEmails: ['dispatcher@example.com'],
      dispatcherSummaryEmailEnabled: true,
      driverSummaryEmailEnabled: true,
      smsRemindersEnabled: true,
    },
  );

  assert.equal(emailSends.length, 3);
  assert.equal(smsSends.length, 1);
});

test('sms client falls back to queue when twilio credentials are unavailable', async () => {
  const queue = [];
  const sms = createSmsChannel({ queue, logger: { warn() {}, info() {}, error() {} } });
  const result = await sms.send({ to: '+15551230001', body: 'hi' });

  assert.equal(sms.provider, 'queue');
  assert.equal(result.queued, true);
  assert.equal(queue.length, 1);
});

test('event bus publishes to subscribers', async () => {
  const bus = createEventBus({ logger: { error() {} } });
  const seen = [];
  bus.subscribe('ride.assigned', async (event) => seen.push(event.type));
  await bus.publish({ type: 'ride.assigned', ride: { id: 'r1' } });
  assert.deepEqual(seen, ['ride.assigned']);
});
