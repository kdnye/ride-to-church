export function getNewlyAssignedRidesForPersistence({ rides, assignments }) {
  const assignmentByRideId = new Map(assignments.map((assignment) => [assignment.rideId, assignment.driverId]));

  return rides.filter((ride) => {
    if (ride.status !== 'assigned' || !ride.driverId) return false;
    return assignmentByRideId.get(ride.id) === ride.driverId;
  });
}
