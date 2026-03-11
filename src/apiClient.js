const API_BASE = '/api';

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    ...options,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error ?? `Request failed: ${response.status}`);
  }
  return payload;
}

export const apiClient = {
  async getUsers() {
    const { users } = await request('/users');
    return users;
  },
  async getRides() {
    const { rides } = await request('/rides');
    return rides;
  },
  async createRide(input) {
    const { ride } = await request('/rides', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return ride;
  },
  async autoAssign(input) {
    return request('/rides/auto-assign', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async getDriverQueue(driverId) {
    const { queue } = await request(`/drivers/${driverId}/queue`);
    return queue;
  },
};
