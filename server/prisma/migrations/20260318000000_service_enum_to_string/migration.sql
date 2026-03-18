-- Convert Service enum columns to plain text.
-- Existing data is preserved: PostgreSQL enum values are already stored as text internally.

-- ConnectorAccount.service
ALTER TABLE "ConnectorAccount" ALTER COLUMN "service" TYPE text USING "service"::text;

-- DataFolder.connectorService
ALTER TABLE "DataFolder" ALTER COLUMN "connectorService" TYPE text USING "connectorService"::text;

-- Asset.service
ALTER TABLE "Asset" ALTER COLUMN "service" TYPE text USING "service"::text;

-- Drop the enum type now that no columns reference it
DROP TYPE "Service";
