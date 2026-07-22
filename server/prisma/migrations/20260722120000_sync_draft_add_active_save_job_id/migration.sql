-- The BullMQ job id of the in-flight apply-sync-draft save job (DEV-10875), or NULL when no save
-- is running. Set by POST /sync-drafts/:draftId/save, cleared by the job on completion/failure.
ALTER TABLE "SyncDraft" ADD COLUMN "activeSaveJobId" TEXT;
