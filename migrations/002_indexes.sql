CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
CREATE INDEX IF NOT EXISTS idx_rides_scheduled_for ON rides(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_ride_assignments_driver_queue ON ride_assignments(driver_id, queue_position);
CREATE INDEX IF NOT EXISTS idx_users_role_approval ON users(role, approval_status);
