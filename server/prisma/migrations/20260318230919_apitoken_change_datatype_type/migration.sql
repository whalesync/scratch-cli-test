/*
  Warnings:

  - The `type` column on the `APIToken` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "APIToken" DROP COLUMN "type",
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'USER';

-- Copy existing type values from cached variant column to type column for data migration
UPDATE "APIToken" SET "type" = "variant";
