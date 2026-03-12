CREATE TABLE IF NOT EXISTS destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  coordinates JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO destinations (name, address, coordinates)
SELECT
  'Main Church Building',
  '123 Main St, Tucson, AZ',
  '{"lat": 32.2226, "lon": -110.9747}'::jsonb
WHERE NOT EXISTS (
  SELECT 1 FROM destinations WHERE name = 'Main Church Building'
);

NOTIFY pgrst, 'reload schema';
