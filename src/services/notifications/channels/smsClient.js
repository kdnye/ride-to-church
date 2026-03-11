const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

function createAuthHeader(accountSid, authToken) {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
}

export function createSmsChannel({
  accountSid,
  authToken,
  fromNumber,
  fetchImpl = fetch,
  logger = console,
  queue = [],
} = {}) {
  const hasTwilioCredentials = Boolean(accountSid && authToken && fromNumber);

  if (!hasTwilioCredentials) {
    return {
      kind: 'sms',
      provider: 'queue',
      async send(message) {
        const queuedMessage = { ...message, queuedAt: new Date().toISOString() };
        queue.push(queuedMessage);
        logger.warn('notification.sms.queued', {
          provider: 'queue',
          to: message.to,
        });
        return { queued: true, queuedMessage };
      },
    };
  }

  return {
    kind: 'sms',
    provider: 'twilio',
    async send(message) {
      const body = new URLSearchParams({
        From: fromNumber,
        To: message.to,
        Body: message.body,
      });

      logger.info('notification.sms.attempt', {
        provider: 'twilio',
        to: message.to,
      });

      const response = await fetchImpl(`${TWILIO_API_BASE}/Accounts/${accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          Authorization: createAuthHeader(accountSid, authToken),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        logger.error('notification.sms.failure', {
          provider: 'twilio',
          to: message.to,
          status: response.status,
          result,
        });
        throw new Error(`Twilio SMS send failed (${response.status}).`);
      }

      logger.info('notification.sms.success', {
        provider: 'twilio',
        to: message.to,
        sid: result.sid,
      });
      return result;
    },
  };
}
