-- AlterTable: add a deep link to the table in the external service's own web UI
-- (a URL on the service's site, e.g. https://airtable.com/{baseId}/{tableId}), so
-- the client can offer an "open in {service}" link. Connector-populated during
-- schema building; null when the service has no constructible deep link.
ALTER TABLE "DataFolder" ADD COLUMN "remoteWebUrl" TEXT;
