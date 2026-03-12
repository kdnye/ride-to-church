CREATE OR REPLACE FUNCTION assign_ride_transactional(
  p_ride_id UUID,
  p_driver_id UUID,
  p_actor_id UUID,
  p_max_rides_per_driver INTEGER,
  p_expected_revision INTEGER,
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL,
  p_ignore_driver_capacity BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  conflict BOOLEAN,
  conflict_reason TEXT,
  ride_id UUID,
  revision INTEGER,
  updated_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_ride rides%ROWTYPE;
  v_existing_driver UUID;
  v_driver_assignment_count INTEGER;
  v_driver_capacity INTEGER;
  v_new_pos INTEGER;
BEGIN
  SELECT * INTO v_ride FROM rides WHERE id = p_ride_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Ride not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_ride.revision <> p_expected_revision
    OR (p_expected_updated_at IS NOT NULL AND v_ride.updated_at <> p_expected_updated_at) THEN
    RETURN QUERY SELECT TRUE, 'stale_ride_version', v_ride.id, v_ride.revision, v_ride.updated_at;
    RETURN;
  END IF;

  SELECT driver_id INTO v_existing_driver FROM ride_assignments WHERE ride_id = p_ride_id FOR UPDATE;

  SELECT COALESCE(daily_ride_capacity, p_max_rides_per_driver)
    INTO v_driver_capacity
  FROM users
  WHERE id = p_driver_id;

  IF v_driver_capacity IS NULL THEN
    v_driver_capacity := p_max_rides_per_driver;
  END IF;

  WITH locked_rows AS (
    SELECT ride_id, queue_position
    FROM ride_assignments
    WHERE driver_id = p_driver_id
    FOR UPDATE
  )
  SELECT COUNT(*) FILTER (WHERE ride_id <> p_ride_id),
         COALESCE(MAX(queue_position), 0) + 1
    INTO v_driver_assignment_count, v_new_pos
  FROM locked_rows;

  IF NOT p_ignore_driver_capacity AND v_driver_assignment_count >= v_driver_capacity THEN
    RETURN QUERY SELECT TRUE, 'driver_at_capacity', v_ride.id, v_ride.revision, v_ride.updated_at;
    RETURN;
  END IF;

  IF v_existing_driver IS NOT NULL AND v_existing_driver <> p_driver_id THEN
    WITH shifted AS (
      UPDATE ride_assignments
      SET queue_position = queue_position - 1
      WHERE driver_id = v_existing_driver
        AND queue_position > (SELECT queue_position FROM ride_assignments WHERE ride_id = p_ride_id)
      RETURNING 1
    )
    SELECT 1;
  END IF;

  INSERT INTO ride_assignments (ride_id, driver_id, queue_position, assigned_by)
  VALUES (p_ride_id, p_driver_id, v_new_pos, p_actor_id)
  ON CONFLICT (ride_id)
  DO UPDATE SET
    driver_id = EXCLUDED.driver_id,
    queue_position = EXCLUDED.queue_position,
    assigned_by = EXCLUDED.assigned_by,
    assigned_at = NOW();

  UPDATE rides
  SET status = 'assigned'
  WHERE id = p_ride_id;

  RETURN QUERY
    SELECT FALSE, NULL::TEXT, r.id, r.revision, r.updated_at
    FROM rides r
    WHERE r.id = p_ride_id;
END;
$$;
