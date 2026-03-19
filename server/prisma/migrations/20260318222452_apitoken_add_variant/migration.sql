-- AlterTable
ALTER TABLE "APIToken" ADD COLUMN     "variant" TEXT NOT NULL DEFAULT 'USER';

-- Copy existing type values into variant for data migration
UPDATE "APIToken" SET "variant" = "type";
