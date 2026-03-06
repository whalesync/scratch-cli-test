-- CreateTable
CREATE TABLE "WorkspacePermission" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'editor',

    CONSTRAINT "WorkspacePermission_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspacePermission_userId_idx" ON "WorkspacePermission"("userId");

-- CreateIndex
CREATE INDEX "WorkspacePermission_workbookId_idx" ON "WorkspacePermission"("workbookId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspacePermission_userId_workbookId_key" ON "WorkspacePermission"("userId", "workbookId");

-- AddForeignKey
ALTER TABLE "WorkspacePermission" ADD CONSTRAINT "WorkspacePermission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspacePermission" ADD CONSTRAINT "WorkspacePermission_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "Workbook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
