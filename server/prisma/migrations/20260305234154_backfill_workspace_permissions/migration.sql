-- Backfill WorkspacePermission records for all users in the same organization as each workbook.
-- For each (user, workbook) pair where the user belongs to the workbook's organization,
-- create a WorkspacePermission with role 'editor' if one does not already exist.
INSERT INTO "WorkspacePermission" ("id", "userId", "workbookId", "role", "createdAt", "updatedAt")
SELECT
  'wpe_' || substr(md5(random()::text || clock_timestamp()::text), 1, 10),
  u."id",
  w."id",
  'editor',
  NOW(),
  NOW()
FROM "User" u
JOIN "Workbook" w ON w."organizationId" = u."organizationId"
WHERE NOT EXISTS (
  SELECT 1 FROM "WorkspacePermission" wp
  WHERE wp."userId" = u."id" AND wp."workbookId" = w."id"
);
