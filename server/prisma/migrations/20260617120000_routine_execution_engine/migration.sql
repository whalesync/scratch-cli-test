-- AlterTable: snapshot the SyncId a `sync` step ran (null for other actions) and the step's
-- timeout in seconds (null = use the per-action default), so the executor never re-reads the
-- (possibly since-edited) YAML.
ALTER TABLE "RoutineRunStep" ADD COLUMN "sync" TEXT;
ALTER TABLE "RoutineRunStep" ADD COLUMN "timeoutSeconds" INTEGER;

-- CreateIndex: enforce "one active run per routine file". A partial UNIQUE index — Prisma
-- cannot express the WHERE predicate declaratively, so it is created here by hand. A second
-- trigger that races a live run violates this and surfaces as a P2002 (mapped to HTTP 409).
CREATE UNIQUE INDEX "RoutineRun_one_active_run_per_file"
  ON "RoutineRun" ("workbookId", "routineFilePath")
  WHERE "status" IN ('pending', 'running');
