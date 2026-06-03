-- AlterTable
ALTER TABLE "PublishPlanOperation" ADD COLUMN     "isRecreate" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "UploadPatchMeta" (
    "id" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "connectorAccountId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "revert" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadPatchMeta_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UploadPatchMeta_workbookId_connectorAccountId_filePath_key" ON "UploadPatchMeta"("workbookId", "connectorAccountId", "filePath");
