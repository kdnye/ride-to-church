const API_BASE = '/api';
const SESSION_SIGNATURE_KEY = 'rtc-session-signature';

function sessionSignature() {
  return window.localStorage.getItem(SESSION_SIGNATURE_KEY);
}


function normalizeRide(ride) {
  if (!ride) return ride;
  return {
    ...ride,
    estimatedArrival: ride.estimatedArrival ?? null,
    routePolyline: ride.routePolyline ?? null,
  };
}

function normalizeQueueItem(item) {
  if (!item) return item;
  return {
    ...item,
    estimatedArrival: item.estimatedArrival ?? null,
    routePolyline: item.routePolyline ?? null,
  };
}

function normalizeDestinationCoordinates(coordinates) {
  if (!coordinates || typeof coordinates !== 'object') return null;
  const lat = Number(coordinates.lat);
  const lon = Number(coordinates.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
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
    if (response.status === 401) {
      window.localStorage.removeItem('rtc-user');
      window.localStorage.removeItem(SESSION_SIGNATURE_KEY);
      window.location.hash = '#/login';
    }
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
  async register(input) {
    return request('/auth/register', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },
  async logout() {
    await request('/auth/logout', { method: 'POST' });
    window.localStorage.removeItem(SESSION_SIGNATURE_KEY);
  },
  async getUsers() {
    const { users } = await request('/users');
    return users;
  },
  async updateUser(userId, updates) {
    return request(`/admin/users/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates),
    });
  },
  async resetRides() {
    return request('/admin/reset-rides', {
      method: 'POST',
    });
  },
  async getRides() {
    const { rides } = await request('/rides');
    return rides.map(normalizeRide);
  },
  async createRide(input) {
    try {
      const { ride } = await request('/rides', {
        method: 'POST',
        body: JSON.stringify(input),
      });
      return normalizeRide(ride);
    } catch (error) {
      if (error.status === 409) {
        error.message = error.details?.error || 'Active ride already exists for that date';
      }
      throw error;
    }
  },
  async autoAssign(payload = {}) {
    const parsedMaxRides = Number(payload.maxRidesPerDriver);
    const cleanPayload = {
      actorId: payload.actorId ?? null,
      maxRidesPerDriver: Number.isFinite(parsedMaxRides) && parsedMaxRides > 0 ? parsedMaxRides : undefined,
      destinationCoordinates: normalizeDestinationCoordinates(payload.destinationCoordinates),
    };

    return request('/rides/auto-assign', {
      method: 'POST',
      body: JSON.stringify(cleanPayload),
    });
  },

  async assignRide(rideId, input) {
    const response = await request(`/rides/${rideId}/assign`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return {
      ...response,
      ride: normalizeRide(response.ride),
      rides: Array.isArray(response.rides) ? response.rides.map(normalizeRide) : response.rides,
      latestRide: normalizeRide(response.latestRide),
    };
  },
  async cancelRide(rideId, input) {
    const response = await request(`/rides/${rideId}/cancel`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return {
      ...response,
      ride: normalizeRide(response.ride),
      rides: Array.isArray(response.rides) ? response.rides.map(normalizeRide) : response.rides,
      latestRide: normalizeRide(response.latestRide),
    };
  },
  async completeRide(rideId, input) {
    const response = await request(`/rides/${rideId}/complete`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return {
      ...response,
      ride: normalizeRide(response.ride),
      rides: Array.isArray(response.rides) ? response.rides.map(normalizeRide) : response.rides,
      latestRide: normalizeRide(response.latestRide),
    };
  },
  async reorderDriverQueue(driverId, input) {
    const response = await request(`/drivers/${driverId}/queue/reorder`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
    return {
      ...response,
      rides: Array.isArray(response.rides) ? response.rides.map(normalizeRide) : response.rides,
      queue: Array.isArray(response.queue) ? response.queue.map(normalizeQueueItem) : response.queue,
      latestRide: normalizeRide(response.latestRide),
    };
  },
  async getDriverQueue(driverId) {
    const { queue } = await request(`/drivers/${driverId}/queue`);
    return queue.map(normalizeQueueItem);
  },
  async getDestinations() {
    const { destinations } = await request('/destinations');
    return destinations;
  },
  async createDestination(destination) {
    return request('/destinations', {
      method: 'POST',
      body: JSON.stringify(destination),
    });
  },
  async deleteDestination(id) {
    await request(`/destinations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    return true;
  },
};
