-- Stable machine-readable classification of a failed publish operation, when the connector
-- recognized the failure (a `ConnectorErrorCode` value from @spinner/shared-types, e.g.
-- "remote_record_not_found"). NULL for unclassified failures. Persisted alongside the
-- human-readable `error` message so frontends can branch on the code, never on the copy.
ALTER TABLE "PublishPlanOperation" ADD COLUMN "errorCode" TEXT;
