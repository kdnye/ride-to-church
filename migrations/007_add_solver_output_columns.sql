ALTER TABLE ride_assignments
ADD COLUMN IF NOT EXISTS estimated_arrival_time TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS route_polyline TEXT;

CREATE INDEX IF NOT EXISTS idx_ride_assignments_estimated_arrival_time
  ON ride_assignments (estimated_arrival_time)
  WHERE estimated_arrival_time IS NOT NULL;
