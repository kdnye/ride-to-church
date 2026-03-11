const EARTH_RADIUS_KM = 6371;

export function haversineDistanceKm(a, b) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

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

export function autoAssignRides({ rides, users }) {
  const drivers = users.filter(
    (u) => u.role === 'volunteer_driver' && u.status === 'approved',
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

    const candidates = nearestDrivers(member, drivers, queueLoads);
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

export function queueForDriver(driverId, rides, users) {
  return rides
    .filter((r) => r.driverId === driverId && r.status === 'assigned')
    .sort((a, b) => (a.queueOrder ?? 999) - (b.queueOrder ?? 999))
    .map((ride) => {
      const member = users.find((u) => u.id === ride.memberId);
      return { ...ride, member };
    });
}
