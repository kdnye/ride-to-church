const EARTH_RADIUS_KM = 6371;

export function haversineDistanceKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function nearestDrivers(member, drivers, queueLoads) {
  return drivers
    .map((driver) => {
      const distanceKm = haversineDistanceKm(member.coordinates, driver.coordinates);
      return {
        ...driver,
        distanceKm,
        load: queueLoads[driver.id] ?? 0,
      };
    })
    .sort((a, b) => a.distanceKm - b.distanceKm || a.load - b.load)
    .slice(0, 3);
}

export function autoAssignRides({ rides, users, maxRidesPerDriver = Infinity }) {
  const drivers = users.filter(
    (u) => u.role === 'volunteer_driver' && u.approval_status === 'approved',
  );

  const queueLoads = Object.fromEntries(drivers.map((d) => [d.id, 0]));
  rides
    .filter((r) => r.status === 'assigned' && r.driverId)
    .forEach((r) => {
      queueLoads[r.driverId] = (queueLoads[r.driverId] ?? 0) + 1;
    });

  const assignments = [];
  for (const ride of rides) {
    if (ride.status !== 'requested') continue;
    const member = users.find((u) => u.id === ride.memberId);
    if (!member) continue;

    const candidates = nearestDrivers(member, drivers, queueLoads)
      .filter((driver) => queueLoads[driver.id] < maxRidesPerDriver);
    if (!candidates.length) continue;

    const selected = candidates[0];
    queueLoads[selected.id] += 1;
    ride.driverId = selected.id;
    ride.status = 'assigned';
    ride.queueOrder = queueLoads[selected.id];

    assignments.push({ rideId: ride.id, driverId: selected.id });
  }

  return assignments;
}

export function autoAssignRidesWithEvents({
  rides,
  users,
  maxRidesPerDriver = Infinity,
  emitEvent,
}) {
  const assignments = [];
  const emittedEvents = [];
  const emit = typeof emitEvent === 'function'
    ? emitEvent
    : (event) => {
      emittedEvents.push(event);
    };

  const drivers = users.filter(
    (u) => u.role === 'volunteer_driver' && u.approval_status === 'approved',
  );

  const queueLoads = Object.fromEntries(drivers.map((d) => [d.id, 0]));
  rides
    .filter((r) => r.status === 'assigned' && r.driverId)
    .forEach((r) => {
      queueLoads[r.driverId] = (queueLoads[r.driverId] ?? 0) + 1;
    });

  for (const ride of rides) {
    if (ride.status !== 'requested') continue;
    const member = users.find((u) => u.id === ride.memberId);
    if (!member) continue;

    const candidates = nearestDrivers(member, drivers, queueLoads)
      .filter((driver) => queueLoads[driver.id] < maxRidesPerDriver);
    if (!candidates.length) continue;

    const selected = candidates[0];
    queueLoads[selected.id] += 1;
    ride.driverId = selected.id;
    ride.status = 'assigned';
    ride.queueOrder = queueLoads[selected.id];

    assignments.push({ rideId: ride.id, driverId: selected.id });

    emit({
      type: 'ride.assigned',
      ride: { ...ride },
      occurredAt: new Date().toISOString(),
    });
    emit({
      type: 'ride.status_changed',
      ride: { ...ride },
      previousStatus: 'requested',
      status: 'assigned',
      occurredAt: new Date().toISOString(),
    });

    if (ride.driverEtaMinutes && ride.driverEtaMinutes <= 10) {
      emit({
        type: 'ride.driver_eta_10m',
        ride: { ...ride },
        occurredAt: new Date().toISOString(),
      });
    }
  }

  return { assignments, emittedEvents };
}

export function queueForDriver(driverId, rides, users) {
  return rides
    .filter((r) => r.driverId === driverId && r.status === 'assigned')
    .sort((a, b) => (a.queueOrder ?? 999) - (b.queueOrder ?? 999))
    .map((ride) => {
      const member = users.find((u) => u.id === ride.memberId);
      return { ...ride, member };
    });
}

function bumpRideVersion(ride, nowIso = new Date().toISOString()) {
  ride.updatedAt = nowIso;
  ride.revision = (ride.revision ?? 0) + 1;
}

export function assignRideWithVersionCheck({
  rides,
  rideId,
  driverId,
  expectedRevision,
  expectedUpdatedAt,
  nowIso,
}) {
  const ride = rides.find((r) => r.id === rideId);
  if (!ride) return { ok: false, code: 'not_found' };
  const hasStaleVersion = ride.revision !== expectedRevision
    || (expectedUpdatedAt && ride.updatedAt !== expectedUpdatedAt);
  if (hasStaleVersion) {
    return {
      ok: false,
      code: 'stale_ride_version',
      latestRide: { ...ride },
    };
  }

  const movingFrom = ride.driverId;
  if (movingFrom && movingFrom !== driverId) {
    rides
      .filter((r) => r.driverId === movingFrom && r.status === 'assigned' && (r.queueOrder ?? 0) > (ride.queueOrder ?? 0))
      .forEach((r) => {
        r.queueOrder -= 1;
      });
  }

  const driverQueue = rides
    .filter((r) => r.driverId === driverId && r.status === 'assigned' && r.id !== rideId)
    .sort((a, b) => (a.queueOrder ?? 999) - (b.queueOrder ?? 999));

  ride.driverId = driverId;
  ride.status = 'assigned';
  ride.queueOrder = driverQueue.length + 1;
  bumpRideVersion(ride, nowIso);

  return { ok: true, ride: { ...ride } };
}

export function reorderQueueAtomicallyWithVersionCheck({
  rides,
  driverId,
  rideId,
  newPosition,
  expectedRevision,
  expectedUpdatedAt,
  nowIso,
}) {
  const ride = rides.find((r) => r.id === rideId);
  if (!ride) return { ok: false, code: 'not_found' };
  const hasStaleVersion = ride.revision !== expectedRevision
    || (expectedUpdatedAt && ride.updatedAt !== expectedUpdatedAt);
  if (hasStaleVersion) {
    return {
      ok: false,
      code: 'stale_ride_version',
      latestRide: { ...ride },
    };
  }

  const queue = rides
    .filter((r) => r.driverId === driverId && r.status === 'assigned')
    .sort((a, b) => (a.queueOrder ?? 999) - (b.queueOrder ?? 999));
  const fromIndex = queue.findIndex((r) => r.id === rideId);
  if (fromIndex < 0) return { ok: false, code: 'ride_not_in_driver_queue' };

  const [moved] = queue.splice(fromIndex, 1);
  const targetIndex = Math.max(0, Math.min(Number(newPosition) - 1, queue.length));
  queue.splice(targetIndex, 0, moved);

  queue.forEach((item, index) => {
    item.queueOrder = index + 1;
  });

  bumpRideVersion(ride, nowIso);

  return {
    ok: true,
    ride: { ...ride },
    queue: queue.map((r) => ({ id: r.id, queueOrder: r.queueOrder })),
  };
}
