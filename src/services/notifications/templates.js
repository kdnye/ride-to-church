function displayName(user, fallback = 'Member') {
  return user?.fullName ?? user?.name ?? fallback;
}

export const notificationTemplates = {
  'ride.assigned': ({ ride, member, driver }) => ({
    memberEmail: {
      subject: 'Your church ride is confirmed',
      textBody: `Hi ${displayName(member)}, your ride is confirmed with ${displayName(driver, 'your driver')}.`,
      htmlBody: `<p>Hi ${displayName(member)},</p><p>Your ride is confirmed with <strong>${displayName(driver, 'your driver')}</strong>.</p>`,
      tag: 'ride-assigned-member',
    },
    dispatcherSummaryEmail: {
      subject: `Ride assigned: ${ride.id}`,
      textBody: `Ride ${ride.id} was assigned to ${displayName(driver, 'driver')} for ${displayName(member)}.`,
      htmlBody: `<p>Ride <strong>${ride.id}</strong> was assigned to ${displayName(driver, 'driver')} for ${displayName(member)}.</p>`,
      tag: 'ride-assigned-dispatcher',
    },
    smsReminder: {
      body: `Ride confirmed: ${displayName(driver, 'Your driver')} is assigned for your church ride.`,
    },
  }),
  'ride.driver_eta_10m': ({ member, driver }) => ({
    memberEmail: {
      subject: 'Your driver is about 10 minutes away',
      textBody: `${displayName(driver, 'Your driver')} is about 10 minutes away.`,
      htmlBody: `<p>${displayName(driver, 'Your driver')} is about <strong>10 minutes away</strong>.</p>`,
      tag: 'ride-eta-10m',
    },
    smsReminder: {
      body: `${displayName(driver, 'Your driver')} is around 10 minutes away.`,
    },
  }),
  'ride.status_changed': ({ ride, member }) => ({
    memberEmail: {
      subject: 'Ride status update',
      textBody: `Your ride ${ride.id} status is now: ${ride.status}.`,
      htmlBody: `<p>Your ride <strong>${ride.id}</strong> status is now: <strong>${ride.status}</strong>.</p>`,
      tag: 'ride-status-changed',
    },
    smsReminder: {
      body: `Ride update: your status is now ${ride.status}.`,
    },
  }),
};
