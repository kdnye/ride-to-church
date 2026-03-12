export const VALID_USER_ROLES = new Set(['member', 'volunteer_driver', 'volunteer_dispatcher', 'people_manager', 'super_admin']);
export const VALID_APPROVAL_STATUSES = new Set(['pending', 'approved', 'rejected', 'deactivated']);

function parseDailyRideCapacity(value) {
  if (value === null) {
    return { ok: true, value: null };
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return { ok: false, error: 'daily_ride_capacity must be a positive integer or null' };
  }

  return { ok: true, value };
}

export function buildUserUpdates({ role, approval_status, daily_ride_capacity } = {}) {
  const updates = {};

  if (role !== undefined) {
    if (!VALID_USER_ROLES.has(role)) {
      return { error: 'Invalid role value' };
    }
    updates.role = role;
  }

  if (approval_status !== undefined) {
    if (!VALID_APPROVAL_STATUSES.has(approval_status)) {
      return { error: 'Invalid approval_status value' };
    }
    updates.approval_status = approval_status;
  }

  if (daily_ride_capacity !== undefined) {
    const parsed = parseDailyRideCapacity(daily_ride_capacity);
    if (!parsed.ok) {
      return { error: parsed.error };
    }
    updates.daily_ride_capacity = parsed.value;
  }

  if (!Object.keys(updates).length) {
    return { error: 'At least one update field is required' };
  }

  return { updates };
}
