const API_BASE = '/api';
const SESSION_SIGNATURE_KEY = 'rtc-session-signature';

function sessionSignature() {
  return window.localStorage.getItem(SESSION_SIGNATURE_KEY);
}

async function request(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(sessionSignature() ? { 'x-session-signature': sessionSignature() } : {}),
      ...(options.headers ?? {}),
    },
    ...options,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error ?? `Request failed: ${response.status}`);
    error.status = response.status;
    error.details = payload;
    throw error;
  }
  return payload;
}

export const apiClient = {
  async login(input) {
    const response = await request('/auth/login', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if (response.sessionSignature) {
      window.localStorage.setItem(SESSION_SIGNATURE_KEY, response.sessionSignature);
    }
    return response;
  },
  async logout() {
    await request('/auth/logout', { method: 'POST' });
    window.localStorage.removeItem(SESSION_SIGNATURE_KEY);
  },
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

  async assignRide(rideId, input) {
    return request(`/rides/${rideId}/assign`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async cancelRide(rideId, input) {
    return request(`/rides/${rideId}/cancel`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async reorderDriverQueue(driverId, input) {
    return request(`/drivers/${driverId}/queue/reorder`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async getDriverQueue(driverId) {
    const { queue } = await request(`/drivers/${driverId}/queue`);
    return queue;
  },
};
