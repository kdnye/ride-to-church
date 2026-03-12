CREATE UNIQUE INDEX IF NOT EXISTS idx_rides_active_member_scheduled_for_unique
  ON rides(member_id, scheduled_for)
  WHERE status IN ('requested', 'assigned');
