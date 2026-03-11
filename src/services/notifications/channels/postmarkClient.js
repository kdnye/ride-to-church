const DEFAULT_POSTMARK_URL = 'https://api.postmarkapp.com/email';

function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required for Postmark email delivery.`);
  }
}

export function createPostmarkEmailChannel({ apiToken, fetchImpl = fetch, logger = console } = {}) {
  required(apiToken, 'POSTMARK_API_TOKEN');

  return {
    kind: 'email',
    provider: 'postmark',
    async send(message) {
      const payload = {
        From: message.from,
        To: message.to,
        Subject: message.subject,
        HtmlBody: message.htmlBody,
        TextBody: message.textBody,
        Tag: message.tag,
        Metadata: message.metadata,
      };

      logger.info('notification.email.attempt', {
        provider: 'postmark',
        to: message.to,
        tag: message.tag,
      });

      const response = await fetchImpl(DEFAULT_POSTMARK_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Postmark-Server-Token': apiToken,
        },
        body: JSON.stringify(payload),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        logger.error('notification.email.failure', {
          provider: 'postmark',
          to: message.to,
          status: response.status,
          body,
        });
        throw new Error(`Postmark email send failed (${response.status}).`);
      }

      logger.info('notification.email.success', {
        provider: 'postmark',
        to: message.to,
        messageId: body.MessageID,
      });

      return body;
    },
  };
}

export function createGuardedEmailChannel(config = {}) {
  const provider = config.provider ?? 'postmark';
  if (provider !== 'postmark') {
    throw new Error('Email provider is blocked. All email must be routed through Postmark.');
  }

  return createPostmarkEmailChannel(config);
}
