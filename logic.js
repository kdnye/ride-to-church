const EARTH_RADIUS_KM = 6371;
const DEFAULT_SPEED_KMH = 35;
const DEFAULT_STOP_SERVICE_MINUTES = 4;

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

export function nearestDrivers(member, drivers, queueLoads, { travelTimeSecondsByDriverId } = {}) {
  return drivers
    .map((driver) => {
      const distanceKm = haversineDistanceKm(member.coordinates, driver.coordinates);
      const travelTimeSeconds = Number(travelTimeSecondsByDriverId?.[driver.id]);
      return {
        ...driver,
        distanceKm,
        travelTimeSeconds: Number.isFinite(travelTimeSeconds) ? travelTimeSeconds : null,
        load: queueLoads[driver.id] ?? 0,
      };
    })
    .sort((a, b) => {
      const aDuration = a.travelTimeSeconds ?? Number.POSITIVE_INFINITY;
      const bDuration = b.travelTimeSeconds ?? Number.POSITIVE_INFINITY;
      return aDuration - bDuration || a.distanceKm - b.distanceKm || a.load - b.load;
    })
    .slice(0, 3);
}

export function autoAssignRides({
  rides,
  users,
  maxRidesPerDriver = Infinity,
  travelTimeSecondsByMemberDriver = {},
}) {
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

    const candidates = nearestDrivers(member, drivers, queueLoads, {
      travelTimeSecondsByDriverId: travelTimeSecondsByMemberDriver[member.id],
    })
      .filter((driver) => {
        const driverCapacity = driver.daily_ride_capacity ?? maxRidesPerDriver;
        return queueLoads[driver.id] < driverCapacity;
      });
    if (!candidates.length) continue;

    const selected = candidates[0];
    queueLoads[selected.id] += 1;
    ride.driverId = selected.id;
    ride.status = 'assigned';
    ride.queueOrder = queueLoads[selected.id];
    ride.travelTimeSeconds = selected.travelTimeSeconds ?? null;

    assignments.push({ rideId: ride.id, driverId: selected.id });
  }

  return assignments;
}

export function autoAssignRidesWithEvents({
  rides,
  users,
  maxRidesPerDriver = Infinity,
  emitEvent,
  travelTimeSecondsByMemberDriver = {},
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

    const candidates = nearestDrivers(member, drivers, queueLoads, {
      travelTimeSecondsByDriverId: travelTimeSecondsByMemberDriver[member.id],
    })
      .filter((driver) => {
        const driverCapacity = driver.daily_ride_capacity ?? maxRidesPerDriver;
        return queueLoads[driver.id] < driverCapacity;
      });
    if (!candidates.length) continue;

    const selected = candidates[0];
    queueLoads[selected.id] += 1;
    ride.driverId = selected.id;
    ride.status = 'assigned';
    ride.queueOrder = queueLoads[selected.id];
    ride.travelTimeSeconds = selected.travelTimeSeconds ?? null;

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

function toEpochMinutes(value) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return Math.floor(timestamp / 60000);
}

export function getRideServiceMinutes(ride) {
  const wheelchairBuffer = Number(ride.wheelchairPickupBufferMinutes ?? 0);
  return DEFAULT_STOP_SERVICE_MINUTES + Math.max(0, wheelchairBuffer);
}

function routeCost(
  queue,
  {
    startCoordinates,
    destinationCoordinates,
    speedKmh = DEFAULT_SPEED_KMH,
    travelTimeLookup,
  } = {},
) {
  if (!queue.length) return 0;
  const speedKmPerMin = speedKmh / 60;
  let total = 0;
  let current = startCoordinates ?? queue[0].member.coordinates;
  let timeCursor = toEpochMinutes(queue[0].scheduledFor) ?? 0;

  for (const ride of queue) {
    const memberCoordinates = ride.member.coordinates;
    const legDistanceKm = current ? haversineDistanceKm(current, memberCoordinates) : 0;
    const travelSeconds = typeof travelTimeLookup === 'function'
      ? travelTimeLookup(current, memberCoordinates)
      : null;
    const legMinutes = Number.isFinite(travelSeconds)
      ? (travelSeconds / 60)
      : (legDistanceKm / speedKmPerMin);
    total += legDistanceKm;
    timeCursor += legMinutes;

    const windowStart = toEpochMinutes(ride.pickupWindowStart);
    const windowEnd = toEpochMinutes(ride.pickupWindowEnd);

    // Penalize early arrivals lightly (with waiting), and late arrivals heavily.
    if (windowStart !== null && timeCursor < windowStart) {
      total += (windowStart - timeCursor) * 0.1;
      timeCursor = windowStart;
    }
    if (windowEnd !== null && timeCursor > windowEnd) {
      total += (timeCursor - windowEnd) * 2;
    }

    const serviceMinutes = getRideServiceMinutes(ride);
    total += serviceMinutes * 0.05;
    timeCursor += serviceMinutes;
    current = memberCoordinates;
  }

  if (destinationCoordinates && current) {
    total += haversineDistanceKm(current, destinationCoordinates);
  }

  return total;
}

function nearestNeighborSeed(stops, startCoordinates) {
  const pending = [...stops];
  const ordered = [];
  let current = startCoordinates;

  while (pending.length) {
    let bestIndex = 0;
    let bestDistance = Infinity;

    pending.forEach((stop, index) => {
      const distance = current
        ? haversineDistanceKm(current, stop.member.coordinates)
        : 0;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });

    const [selected] = pending.splice(bestIndex, 1);
    ordered.push(selected);
    current = selected.member.coordinates;
  }

  return ordered;
}

function twoOpt(queue, options) {
  if (queue.length < 4) return queue;
  let best = queue;
  let bestCost = routeCost(queue, options);
  let improved = true;

  while (improved) {
    improved = false;
    for (let i = 1; i < best.length - 2; i += 1) {
      for (let k = i + 1; k < best.length - 1; k += 1) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, k + 1).reverse(),
          ...best.slice(k + 1),
        ];
        const candidateCost = routeCost(candidate, options);
        if (candidateCost + 1e-9 < bestCost) {
          best = candidate;
          bestCost = candidateCost;
          improved = true;
        }
      }
    }
  }

  return best;
}

export function optimizeDriverQueue({
  rides,
  driverCoordinates,
  destinationCoordinates,
  speedKmh = DEFAULT_SPEED_KMH,
  travelTimeLookup,
}) {
  const assigned = rides.filter((ride) => ride.status === 'assigned' && ride.member?.coordinates);
  if (assigned.length <= 1) {
    return assigned.map((ride, index) => ({ ...ride, queueOrder: index + 1 }));
  }

  const seeded = nearestNeighborSeed(assigned, driverCoordinates);
  const optimized = twoOpt(seeded, {
    startCoordinates: driverCoordinates,
    destinationCoordinates,
    speedKmh,
    travelTimeLookup,
  });

  return optimized.map((ride, index) => ({ ...ride, queueOrder: index + 1 }));
}
