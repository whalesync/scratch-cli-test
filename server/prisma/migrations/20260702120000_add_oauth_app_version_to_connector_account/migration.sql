-- Track which generation of OAuth *app* credentials issued each connection's tokens
-- (1 = legacy Scratch apps, 2 = unified Whalesync apps). Additive + backfilled: the
-- DEFAULT 1 backfills every existing ConnectorAccount to the legacy apps, so existing
-- connections keep refreshing against the app that issued their refresh token.
-- AlterTable
ALTER TABLE "ConnectorAccount" ADD COLUMN     "oauthAppVersion" INTEGER NOT NULL DEFAULT 1;
