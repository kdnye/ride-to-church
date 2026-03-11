export function createEventBus({ logger = console } = {}) {
  const subscribers = new Map();

  return {
    subscribe(eventType, handler) {
      const existing = subscribers.get(eventType) ?? [];
      subscribers.set(eventType, [...existing, handler]);
      return () => {
        const current = subscribers.get(eventType) ?? [];
        subscribers.set(eventType, current.filter((h) => h !== handler));
      };
    },
    async publish(event) {
      const handlers = subscribers.get(event.type) ?? [];
      const wildcardHandlers = subscribers.get('*') ?? [];
      const allHandlers = [...handlers, ...wildcardHandlers];

      const results = [];
      for (const handler of allHandlers) {
        try {
          results.push(await handler(event));
        } catch (error) {
          logger.error('notification.event.handler_failed', {
            type: event.type,
            error: error.message,
          });
          throw error;
        }
      }

      return results;
    },
  };
}
