export const ROUTE_MATRIX_LIMITS = {
  maxOriginsPerRequest: 25,
  maxDestinationsPerRequest: 25,
  maxElementsPerRequest: 625,
};

function chunkWithStartIndexes(items, chunkSize) {
  if (!Array.isArray(items) || chunkSize <= 0) return [];
  const chunks = [];
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push({
      startIndex: index,
      items: items.slice(index, index + chunkSize),
    });
  }
  return chunks;
}

function getRequestedMembers({ rides, memberById }) {
  const requestedMemberIds = [];
  const requestedMemberIdSet = new Set();
  rides.forEach((ride) => {
    if (ride.status !== 'requested') return;
    if (requestedMemberIdSet.has(ride.memberId)) return;
    const member = memberById.get(ride.memberId);
    if (!member?.coordinates) return;
    requestedMemberIdSet.add(ride.memberId);
    requestedMemberIds.push(ride.memberId);
  });
  return requestedMemberIds;
}

export async function buildMemberDriverTravelTimes({
  rides,
  users,
  apiKey,
  routeMatrixEnabled,
  getRouteMatrixDurationsSeconds,
  limits = ROUTE_MATRIX_LIMITS,
}) {
  if (!routeMatrixEnabled || !apiKey) return {};

  const approvedDrivers = users
    .filter((user) => user.role === 'volunteer_driver' && user.approval_status === 'approved' && user.coordinates);

  if (!approvedDrivers.length) return {};

  const memberById = new Map(users.filter((user) => user.role === 'member').map((user) => [user.id, user]));
  const requestedMemberIds = getRequestedMembers({ rides, memberById });
  if (!requestedMemberIds.length) return {};

  const origins = approvedDrivers.map((driver) => driver.coordinates);
  const destinations = requestedMemberIds.map((memberId) => memberById.get(memberId).coordinates);

  const originChunks = chunkWithStartIndexes(origins, limits.maxOriginsPerRequest);
  const destinationChunks = chunkWithStartIndexes(destinations, limits.maxDestinationsPerRequest);

  const travelTimeSecondsByMemberDriver = {};

  // deterministic chunking by origin chunk first, then destination chunk.
  for (const originChunk of originChunks) {
    for (const destinationChunk of destinationChunks) {
      const maxDestinationsByElementCap = Math.max(1, Math.floor(limits.maxElementsPerRequest / originChunk.items.length));
      const cappedDestinationChunks = chunkWithStartIndexes(destinationChunk.items, maxDestinationsByElementCap);

      for (const cappedDestinationChunk of cappedDestinationChunks) {
        const rows = await getRouteMatrixDurationsSeconds({
          origins: originChunk.items,
          destinations: cappedDestinationChunk.items,
          apiKey,
        });

        rows.forEach((row) => {
          const globalOriginIndex = originChunk.startIndex + row.originIndex;
          const globalDestinationIndex = destinationChunk.startIndex + cappedDestinationChunk.startIndex + row.destinationIndex;
          const driver = approvedDrivers[globalOriginIndex];
          const memberId = requestedMemberIds[globalDestinationIndex];
          if (!driver || !memberId) return;
          if (!Number.isFinite(row.durationSeconds)) return;

          travelTimeSecondsByMemberDriver[memberId] ??= {};
          travelTimeSecondsByMemberDriver[memberId][driver.id] = row.durationSeconds;
        });
      }
    }
  }

  return travelTimeSecondsByMemberDriver;
}
