-- DEV-12616: each linked DataFolder's table spec (.scratch/{folder}/schema.json in the connection's git
-- repo) and default view (.scratch/{folder}/views/default.json) move into Postgres. Postgres becomes the
-- source of truth; the git files become a one-way mirror the scratchmd CLI and Desktop still read.
-- TEXT, not jsonb: jsonb reorders keys and Prisma Json input can round numbers (DEV-12614).
-- Adding a table is safe for revisions still running during rollout (they never touch it).

-- CreateTable
CREATE TABLE "DataFolderTableSpec" (
    "dataFolderId" TEXT NOT NULL,
    "tableSpecContent" TEXT NOT NULL,
    "defaultViewContent" TEXT,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataFolderTableSpec_pkey" PRIMARY KEY ("dataFolderId")
);

-- AddForeignKey
ALTER TABLE "DataFolderTableSpec" ADD CONSTRAINT "DataFolderTableSpec_dataFolderId_fkey" FOREIGN KEY ("dataFolderId") REFERENCES "DataFolder"("id") ON DELETE CASCADE ON UPDATE CASCADE;
