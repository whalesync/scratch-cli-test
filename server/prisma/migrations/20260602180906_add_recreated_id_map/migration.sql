-- CreateTable
CREATE TABLE "RecreatedIdMap" (
    "id" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "connectorAccountId" TEXT NOT NULL,
    "folder" TEXT NOT NULL,
    "priorRemoteId" TEXT NOT NULL,
    "newRemoteId" TEXT NOT NULL,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecreatedIdMap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RecreatedIdMap_workbookId_connectorAccountId_folder_newRemo_idx" ON "RecreatedIdMap"("workbookId", "connectorAccountId", "folder", "newRemoteId");

-- CreateIndex
CREATE UNIQUE INDEX "RecreatedIdMap_workbookId_connectorAccountId_folder_priorRe_key" ON "RecreatedIdMap"("workbookId", "connectorAccountId", "folder", "priorRemoteId");
