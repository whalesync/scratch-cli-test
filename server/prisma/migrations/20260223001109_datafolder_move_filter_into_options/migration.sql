-- Migrate non-null filter values into the options JSON column
UPDATE "DataFolder"
SET "options" = jsonb_set(
  COALESCE("options"::jsonb, '{}'::jsonb),
  '{filter}',
  to_jsonb("filter")
)
WHERE "filter" IS NOT NULL
  AND NOT COALESCE("options"::jsonb, '{}'::jsonb) ? 'filter';
