-- AlterTable
ALTER TABLE "Sync" ADD COLUMN     "aiPromptHistory" JSONB[] DEFAULT ARRAY[]::JSONB[];
