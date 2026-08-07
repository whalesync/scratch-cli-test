-- The container a table lives in on the external service (Airtable base, Google
-- Sheets spreadsheet, Supabase project+schema, Notion parent page), so the client
-- can show "this table lives in X" and link there. Connector-populated during
-- schema building and refreshed on every pull, so a container rename follows.
-- All nullable: existing rows simply carry no container until their next pull.
ALTER TABLE "DataFolder" ADD COLUMN "remoteContainerId" TEXT;
ALTER TABLE "DataFolder" ADD COLUMN "remoteContainerName" TEXT;
ALTER TABLE "DataFolder" ADD COLUMN "remoteContainerWebUrl" TEXT;
