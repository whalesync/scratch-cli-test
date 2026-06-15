-- CreateTable
CREATE TABLE "SyncDraft" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workbookId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "displayName" TEXT NOT NULL,
    "schedule" TEXT,
    "sourceSyncId" TEXT,
    "tableMappings" JSONB NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "appliedSyncId" TEXT,

    CONSTRAINT "SyncDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SyncDraft_workbookId_idx" ON "SyncDraft"("workbookId");

-- AddForeignKey
ALTER TABLE "SyncDraft" ADD CONSTRAINT "SyncDraft_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "Workbook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
