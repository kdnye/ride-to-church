ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT;

CREATE OR REPLACE FUNCTION register_user(
  p_full_name TEXT,
  p_email TEXT,
  p_password TEXT,
  p_phone TEXT DEFAULT NULL
)
RETURNS users
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_user users;
BEGIN
  INSERT INTO users (full_name, email, phone, password_hash)
  VALUES (
    p_full_name,
    LOWER(TRIM(p_email)),
    NULLIF(TRIM(p_phone), ''),
    crypt(p_password, gen_salt('bf'))
  )
  RETURNING * INTO v_user;

  RETURN v_user;
END;
$$;

CREATE OR REPLACE FUNCTION verify_user_password(
  p_email TEXT,
  p_password TEXT
)
RETURNS TABLE (id UUID, role user_role, approval_status approval_status)
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT u.id, u.role, u.approval_status
  FROM users u
  WHERE u.email = LOWER(TRIM(p_email))
    AND u.password_hash IS NOT NULL
    AND u.password_hash = crypt(p_password, u.password_hash)
  LIMIT 1;
$$;

INSERT INTO users (full_name, email, role, approval_status, password_hash)
VALUES (
  'System Admin',
  'kd7kxw@gmail.com',
  'super_admin',
  'approved',
  crypt('ChangemeNow123!', gen_salt('bf'))
)
ON CONFLICT (email) DO UPDATE
SET
  role = 'super_admin',
  approval_status = 'approved',
  password_hash = crypt('ChangemeNow123!', gen_salt('bf'));
