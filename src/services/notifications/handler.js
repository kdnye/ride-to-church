import { notificationTemplates } from './templates.js';

function assertPostmarkEmailChannel(emailChannel) {
  if (!emailChannel || emailChannel.kind !== 'email' || emailChannel.provider !== 'postmark') {
    throw new Error('Blocked email send path. Use the Postmark email channel wrapper only.');
  }
}

function usersById(users = []) {
  return new Map(users.map((u) => [u.id, u]));
}

export function createNotificationEventHandler({
  emailChannel,
  smsChannel,
  logger = console,
  templates = notificationTemplates,
} = {}) {
  assertPostmarkEmailChannel(emailChannel);

  return {
    async handle(event, context = {}) {
      const render = templates[event.type];
      if (!render) {
        logger.info('notification.event.ignored', { type: event.type });
        return [];
      }

      const userMap = usersById(context.users);
      const ride = event.ride;
      const member = userMap.get(ride.memberId);
      const driver = userMap.get(ride.driverId);
      const dispatcherEmails = context.dispatcherEmails ?? [];
      const outputs = render({ event, ride, member, driver });
      const results = [];

      if (member?.email && outputs.memberEmail) {
        results.push(await emailChannel.send({
          from: context.fromEmail,
          to: member.email,
          ...outputs.memberEmail,
          metadata: { rideId: ride.id, eventType: event.type, recipientType: 'member' },
        }));
      }

      if (driver?.email && outputs.dispatcherSummaryEmail && context.driverSummaryEmailEnabled) {
        results.push(await emailChannel.send({
          from: context.fromEmail,
          to: driver.email,
          ...outputs.dispatcherSummaryEmail,
          metadata: { rideId: ride.id, eventType: event.type, recipientType: 'driver' },
        }));
      }

      if (outputs.dispatcherSummaryEmail && context.dispatcherSummaryEmailEnabled) {
        // eslint-disable-next-line no-restricted-syntax
        for (const email of dispatcherEmails) {
          results.push(await emailChannel.send({
            from: context.fromEmail,
            to: email,
            ...outputs.dispatcherSummaryEmail,
            metadata: { rideId: ride.id, eventType: event.type, recipientType: 'dispatcher' },
          }));
        }
      }

      if (member?.phone && outputs.smsReminder && context.smsRemindersEnabled && smsChannel) {
        results.push(await smsChannel.send({
          to: member.phone,
          ...outputs.smsReminder,
          metadata: { rideId: ride.id, eventType: event.type },
        }));
      }

      logger.info('notification.event.processed', {
        type: event.type,
        rideId: ride.id,
        deliveries: results.length,
      });

      return results;
    },
  };
}
