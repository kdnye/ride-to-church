export function canAccessDriverQueue(session, requestedDriverId) {
  if (!session || !requestedDriverId) return false;
  if (session.role !== 'volunteer_driver') return true;
  return session.userId === requestedDriverId;
}
