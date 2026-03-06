-- Grant read-only access to the "readonly" user.
-- In cloud environments, Terraform creates this user with a password.
-- In local/CI environments, this creates the role without a password.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'readonly') THEN
    CREATE ROLE readonly WITH LOGIN;
  END IF;
END
$$;

-- Allow access to the public schema
GRANT USAGE ON SCHEMA public TO readonly;

-- Grant SELECT on all existing tables
GRANT SELECT ON ALL TABLES IN SCHEMA public TO readonly;

-- Automatically grant SELECT on any tables created in the future
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO readonly;
