-- CreateTable
CREATE TABLE "PendingOAuthInstall" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "service" TEXT NOT NULL,
    "encryptedCredentials" JSONB NOT NULL,
    "workspaceId" TEXT,
    "displayName" TEXT,
    "claimedByUserId" TEXT,
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "PendingOAuthInstall_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingOAuthInstall_expiresAt_idx" ON "PendingOAuthInstall"("expiresAt");
