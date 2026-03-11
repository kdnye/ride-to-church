CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TYPE user_role AS ENUM (
  'member',
  'volunteer_driver',
  'volunteer_dispatcher',
  'people_manager',
  'super_admin'
);

CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected', 'deactivated');
CREATE TYPE ride_status AS ENUM ('requested', 'assigned', 'in_progress', 'completed', 'cancelled');

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  email TEXT UNIQUE,
  phone TEXT,
  home_address TEXT,
  coordinates GEOGRAPHY(POINT, 4326),
  role user_role NOT NULL DEFAULT 'member',
  approval_status approval_status NOT NULL DEFAULT 'pending',
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES users(id),
  scheduled_for DATE NOT NULL,
  pickup_notes TEXT,
  status ride_status NOT NULL DEFAULT 'requested',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ride_assignments (
  ride_id UUID PRIMARY KEY REFERENCES rides(id) ON DELETE CASCADE,
  driver_id UUID NOT NULL REFERENCES users(id),
  queue_position INTEGER NOT NULL CHECK (queue_position > 0),
  assigned_by UUID REFERENCES users(id),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
