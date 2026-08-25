-- A table with NO primary key and a single-column UNIQUE index on a NULLABLE
-- column (`ext_key`). The Postgres connector still lists and links it (it has a
-- single-column unique index) and picks `ext_key` as the record id path — but a
-- row whose `ext_key` is NULL has no resolvable remote id, so pull commits its
-- file to `main` WITHOUT a FileIndex row. Deleting that file then publishes a
-- delete operation with a null remoteRecordId, which must be surfaced as a
-- failure rather than a silent success (DEV-10595).
CREATE TABLE integration_nullkey (
    ext_key   TEXT UNIQUE,
    name      TEXT NOT NULL
);
