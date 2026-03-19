-- AlterTable
ALTER TABLE "User" ADD COLUMN "waitlistApproved" BOOLEAN NOT NULL DEFAULT false;

-- Auto-approve all existing users
UPDATE "User" SET "waitlistApproved" = true;
