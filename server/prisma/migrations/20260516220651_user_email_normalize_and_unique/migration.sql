-- Normalize User.email and enforce case-insensitive uniqueness via a BEFORE
-- INSERT/UPDATE trigger that lowercases and trims the value. The same trigger
-- is applied to WorkspaceInvites.email so lookups by email match consistently.

-- Backfill: lowercase + trim existing User emails.
UPDATE "User"
SET email = lower(btrim(email))
WHERE email IS NOT NULL AND email <> lower(btrim(email));

-- Deduplicate WorkspaceInvites by (lower(email), workbookId) before normalizing,
-- keeping the most recently updated row. The existing @@unique([email, workbookId])
-- would otherwise reject the backfill UPDATE if two invites differ only in case.
DELETE FROM "WorkspaceInvites" a
USING "WorkspaceInvites" b
WHERE a.id <> b.id
  AND a."workbookId" = b."workbookId"
  AND lower(btrim(a.email)) = lower(btrim(b.email))
  AND (a."updatedAt", a.id) < (b."updatedAt", b.id);

-- Backfill: lowercase + trim existing WorkspaceInvites emails.
UPDATE "WorkspaceInvites"
SET email = lower(btrim(email))
WHERE email <> lower(btrim(email));

-- Trigger function: normalize NEW.email to lowercase + trimmed.
-- lower(btrim(NULL)) returns NULL, so this is safe for nullable columns.
CREATE OR REPLACE FUNCTION normalize_email() RETURNS trigger AS $$
BEGIN
  NEW.email := lower(btrim(NEW.email));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER user_email_normalize
  BEFORE INSERT OR UPDATE OF email ON "User"
  FOR EACH ROW EXECUTE FUNCTION normalize_email();

CREATE TRIGGER workspaceinvites_email_normalize
  BEFORE INSERT OR UPDATE OF email ON "WorkspaceInvites"
  FOR EACH ROW EXECUTE FUNCTION normalize_email();

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
