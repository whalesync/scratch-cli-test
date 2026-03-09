-- CreateTable
CREATE TABLE "WorkspaceInvites" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "email" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'editor',
    "userId" TEXT,

    CONSTRAINT "WorkspaceInvites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkspaceInvites_email_idx" ON "WorkspaceInvites"("email");

-- CreateIndex
CREATE INDEX "WorkspaceInvites_workbookId_idx" ON "WorkspaceInvites"("workbookId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceInvites_email_workbookId_key" ON "WorkspaceInvites"("email", "workbookId");

-- AddForeignKey
ALTER TABLE "WorkspaceInvites" ADD CONSTRAINT "WorkspaceInvites_workbookId_fkey" FOREIGN KEY ("workbookId") REFERENCES "Workbook"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInvites" ADD CONSTRAINT "WorkspaceInvites_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
