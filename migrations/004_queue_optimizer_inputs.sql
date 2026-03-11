ALTER TABLE rides
  ADD COLUMN IF NOT EXISTS wheelchair_pickup_buffer_minutes INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pickup_window_start TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pickup_window_end TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'rides_pickup_window_order_chk'
  ) THEN
    ALTER TABLE rides
      ADD CONSTRAINT rides_pickup_window_order_chk
      CHECK (pickup_window_start IS NULL OR pickup_window_end IS NULL OR pickup_window_end >= pickup_window_start);
  END IF;
END
$$;
