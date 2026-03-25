-- Deduplicate DataFolder.name within each workbook (unique goal: ("workbookId", name)).
--
-- Forward: rows in duplicate groups with row_number > 1 get name := name || '__DEDUP__' || id
--   (__DEDUP__ + primary key is unique and avoids collisions with other rows).
--
-- Reverse: strip a trailing __DEDUP__<id> token (id = letters, digits, hyphen, underscore).
--
-- Run forward only if @@unique([workbookId, name]) is not yet enforced, or after temporarily
-- dropping that constraint; otherwise PostgreSQL would not allow duplicate rows to exist.
--
-- Verify before (should return rows if cleanup needed):
--   SELECT "workbookId", name, COUNT(*) FROM "DataFolder" GROUP BY 1, 2 HAVING COUNT(*) > 1;
--
-- Verify after (should return zero rows):
--   SELECT "workbookId", name, COUNT(*) FROM "DataFolder" GROUP BY 1, 2 HAVING COUNT(*) > 1;

BEGIN;

-- Optional dry-run (comment out when executing for real):
-- WITH numbered AS (
--   SELECT id,
--     ROW_NUMBER() OVER (PARTITION BY "workbookId", name ORDER BY id) AS rn
--   FROM "DataFolder"
-- )
-- SELECT df.id, df."workbookId", df.name AS old_name, df.name || '__DEDUP__' || df.id AS new_name
-- FROM "DataFolder" df
-- INNER JOIN numbered n ON n.id = df.id
-- WHERE n.rn > 1;

WITH numbered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "workbookId", name
      ORDER BY
        id
    ) AS rn
  FROM "DataFolder"
)
UPDATE "DataFolder" df
SET name = df.name || '__DEDUP__' || df.id
FROM numbered n
WHERE n.id = df.id
  AND n.rn > 1;

COMMIT;

-- ---------------------------------------------------------------------------
-- ROLLBACK / reversal (run in a separate transaction after forward if needed)
-- ---------------------------------------------------------------------------
--
-- BEGIN;
--
-- UPDATE "DataFolder"
-- SET name = regexp_replace(name, '__DEDUP__[A-Za-z0-9_-]+$', '')
-- WHERE name ~ '__DEDUP__[A-Za-z0-9_-]+$';
--
-- -- Re-check duplicates before commit; if any appeared, ROLLBACK.
-- -- SELECT "workbookId", name, COUNT(*) FROM "DataFolder" GROUP BY 1, 2 HAVING COUNT(*) > 1;
--
-- COMMIT;
