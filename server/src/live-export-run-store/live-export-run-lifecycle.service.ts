import { Inject, Injectable } from '@nestjs/common';
import { LiveExportEngine } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { LiveExportEngineService, type RoutineStepForEngineDecision } from './live-export-engine.service';
import { type RunStoreClient, type RunStoreKey, runStoreKeyForRoutineRun } from './run-store-client';
import { RUN_STORE_CLIENT } from './run-store-client.token';

/**
 * The routine executor's hooks into the Live Export run-store engine: decide (once) which engine a run
 * uses, and delete the run's store when the run ends. Kept behind one service so the executor stays
 * engine-agnostic — for a classic run both hooks are no-ops.
 */
@Injectable()
export class LiveExportRunLifecycleService {
  constructor(
    private readonly db: DbService,
    private readonly liveExportEngineService: LiveExportEngineService,
    @Inject(RUN_STORE_CLIENT) private readonly runStoreClient: RunStoreClient,
  ) {}

  /**
   * The run store key every step job of this run should use, or undefined for a classic run. The
   * engine is decided on the run's first drive and persisted on the run, so a resumed run (or a
   * setting changed mid-run) keeps the engine it started with. Never throws: if the decision itself
   * fails, the run goes classic.
   */
  async resolveRunStoreKeyForRun(
    run: { id: string; workbookId: string; liveExportEngine: string | null; currentStepIndex: number },
    steps: RoutineStepForEngineDecision[],
  ): Promise<RunStoreKey | undefined> {
    try {
      const engine = run.liveExportEngine ?? (await this.decideAndPersistEngine(run, steps));
      return engine === LiveExportEngine.RUN_STORE ? runStoreKeyForRoutineRun(run.id) : undefined;
    } catch (error) {
      WSLogger.warn({
        source: 'LiveExportRunLifecycleService',
        message: 'Resolving the Live Export engine failed; this drive of the run uses the classic engine',
        routineRunId: run.id,
        workbookId: run.workbookId,
        error,
      });
      return undefined;
    }
  }

  private async decideAndPersistEngine(
    run: { id: string; workbookId: string; currentStepIndex: number },
    steps: RoutineStepForEngineDecision[],
  ): Promise<string> {
    let decidedEngine: string = LiveExportEngine.CLASSIC;
    // A run already past its first step with no engine recorded (e.g. it started before this code was
    // deployed) has done its early steps classically; the run store it would need was never created.
    if (run.currentStepIndex === 0) {
      try {
        decidedEngine = (
          await this.liveExportEngineService.decideEngineForRoutineRun({
            workbookId: run.workbookId,
            routineRunId: run.id,
            steps,
          })
        ).engine;
        if (decidedEngine === LiveExportEngine.RUN_STORE) {
          // Create the store now, before anything is committed to the run-store engine: when the git
          // service has no room (its run-store byte budget is used up), the run goes classic instead of
          // failing. The discard step clears it again, which is cheap on an empty store.
          await this.runStoreClient.createOrClearRunStore(runStoreKeyForRoutineRun(run.id));
        }
      } catch (error) {
        decidedEngine = LiveExportEngine.CLASSIC;
        WSLogger.warn({
          source: 'LiveExportRunLifecycleService',
          message: 'Deciding the Live Export engine or creating its run store failed; the run uses the classic engine',
          routineRunId: run.id,
          workbookId: run.workbookId,
          error,
        });
      }
    }
    // Only the first driver's decision sticks (a concurrent re-drive re-reads it).
    await this.db.client.routineRun.updateMany({
      where: { id: run.id, liveExportEngine: null },
      data: { liveExportEngine: decidedEngine },
    });
    const persisted = await this.db.client.routineRun.findUnique({
      where: { id: run.id },
      select: { liveExportEngine: true },
    });
    return persisted?.liveExportEngine ?? decidedEngine;
  }

  /**
   * Deletes a finished run's store (all of its per-record data). Fire-and-forget and never throws: a
   * store left behind is removed by the staging-dir reaper (24 h / byte budget).
   */
  releaseRunStoreOfFinishedRun(runId: string): void {
    void this.db.client.routineRun
      .findUnique({ where: { id: runId }, select: { liveExportEngine: true } })
      .then(async (run) => {
        if (run?.liveExportEngine !== LiveExportEngine.RUN_STORE) return;
        const startedAt = Date.now();
        await this.runStoreClient.deleteRunStore(runStoreKeyForRoutineRun(runId));
        WSLogger.info({
          source: 'LiveExportRunLifecycleService',
          message: 'Deleted the run store of a finished Live Export run',
          routineRunId: runId,
          durationMs: Date.now() - startedAt,
        });
      })
      .catch((error: unknown) => {
        WSLogger.warn({
          source: 'LiveExportRunLifecycleService',
          message: 'Failed to delete the run store of a finished Live Export run (the reaper will remove it)',
          routineRunId: runId,
          error,
        });
      });
  }
}
