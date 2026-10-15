-- DEV-12330: outbox of failed Live Export runs to push to Whalesync, which emails the export's owner.

-- CreateTable
CREATE TABLE "WhalesyncRunNotification" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "routineRunId" TEXT NOT NULL,
    "workbookId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "WhalesyncRunNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhalesyncRunNotification_routineRunId_key" ON "WhalesyncRunNotification"("routineRunId");

-- CreateIndex
CREATE INDEX "WhalesyncRunNotification_deliveredAt_nextAttemptAt_idx" ON "WhalesyncRunNotification"("deliveredAt", "nextAttemptAt");

-- AddForeignKey
ALTER TABLE "WhalesyncRunNotification" ADD CONSTRAINT "WhalesyncRunNotification_routineRunId_fkey" FOREIGN KEY ("routineRunId") REFERENCES "RoutineRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
