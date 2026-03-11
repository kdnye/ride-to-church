ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION set_ride_timestamps_and_revision()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  NEW.revision = OLD.revision + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rides_touch_revision ON rides;
CREATE TRIGGER trg_rides_touch_revision
BEFORE UPDATE ON rides
FOR EACH ROW
EXECUTE FUNCTION set_ride_timestamps_and_revision();

CREATE OR REPLACE FUNCTION assign_ride_transactional(
  p_ride_id UUID,
  p_driver_id UUID,
  p_actor_id UUID,
  p_expected_revision INTEGER,
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL
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

  WITH locked_rows AS (
    SELECT queue_position
    FROM ride_assignments
    WHERE driver_id = p_driver_id
    FOR UPDATE
  )
  SELECT COALESCE(MAX(queue_position), 0) + 1 INTO v_new_pos
  FROM locked_rows;

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

CREATE OR REPLACE FUNCTION reorder_driver_queue_transactional(
  p_driver_id UUID,
  p_ride_id UUID,
  p_new_position INTEGER,
  p_actor_id UUID,
  p_expected_revision INTEGER,
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL
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
  v_count INTEGER;
  v_target INTEGER;
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

  WITH locked_rows AS (
    SELECT ride_id
    FROM ride_assignments
    WHERE driver_id = p_driver_id
    FOR UPDATE
  )
  SELECT COUNT(*) INTO v_count
  FROM locked_rows;

  IF v_count = 0 THEN
    RETURN QUERY SELECT FALSE, NULL::TEXT, v_ride.id, v_ride.revision, v_ride.updated_at;
    RETURN;
  END IF;

  v_target = GREATEST(1, LEAST(p_new_position, v_count));

  WITH ordered AS (
    SELECT ra.ride_id,
           ROW_NUMBER() OVER (
             ORDER BY CASE WHEN ra.ride_id = p_ride_id THEN 1 ELSE 0 END,
                      CASE WHEN ra.ride_id = p_ride_id THEN 2147483647 ELSE ra.queue_position END,
                      ra.ride_id
           ) AS base_idx
    FROM ride_assignments ra
    WHERE ra.driver_id = p_driver_id
  ),
  shifted AS (
    SELECT ride_id,
           CASE
             WHEN ride_id = p_ride_id THEN v_target
             WHEN base_idx >= v_target AND ride_id <> p_ride_id THEN base_idx + 1
             ELSE base_idx
           END AS next_position
    FROM ordered
  ),
  normalized AS (
    SELECT ride_id,
           ROW_NUMBER() OVER (ORDER BY next_position, ride_id) AS normalized_position
    FROM shifted
  )
  UPDATE ride_assignments ra
  SET queue_position = n.normalized_position
  FROM normalized n
  WHERE ra.ride_id = n.ride_id
    AND ra.driver_id = p_driver_id;

  UPDATE rides r
  SET status = 'assigned'
  WHERE r.id IN (
    SELECT ride_id FROM ride_assignments WHERE driver_id = p_driver_id
  );

  RETURN QUERY
    SELECT FALSE, NULL::TEXT, r.id, r.revision, r.updated_at
    FROM rides r
    WHERE r.id = p_ride_id;
END;
$$;
