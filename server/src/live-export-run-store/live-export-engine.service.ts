import { Injectable } from '@nestjs/common';
import {
  LiveExportEngine,
  liveExportEngineRequestedBySettings,
  RoutineAction,
  TransformerTypes,
  transformV1ToV2,
  WorkbookManager,
  type WorkbookSettings,
} from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { SystemFeatureFlag } from 'src/experiments/flags';
import { WSLogger } from 'src/logger';
import { findTransformerConfigsV2 } from 'src/sync/sync-execution';
import { parseStoredMappings } from 'src/sync/sync-mapping.schema';

/** A routine step as far as the engine decision is concerned. */
export interface RoutineStepForEngineDecision {
  action: string;
  /** Resolved sync id for SYNC steps. */
  syncId?: string | null;
  /** The step's snapshotted options (`fullPull` for PULL steps). */
  options?: unknown;
  /** Resolved DataFolder ids a PULL step pulls. */
  pullDataFolderIds?: string[];
}

export interface LiveExportEngineDecision {
  engine: LiveExportEngine;
  /** Why — logged, and useful when a run the user switched to `run_store` still ran classic. */
  reason: string;
}

const ASSET_TRANSFORMER_TYPES = [TransformerTypes.SourceAssetToDestAsset, TransformerTypes.MatchAssetByHash];

const ACTIONS_THE_RUN_STORE_ENGINE_HANDLES = new Set<string>([
  RoutineAction.DISCARD_PENDING_CHANGES,
  RoutineAction.PULL,
  RoutineAction.SYNC,
  RoutineAction.PUBLISH,
]);

function isStepAction(step: RoutineStepForEngineDecision, action: RoutineAction): boolean {
  return step.action === String(action);
}

/** Every `…DataFolderId` value anywhere inside a transformer's options (FK and lookup targets, …). */
function collectDataFolderIdsInTransformerOptions(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectDataFolderIdsInTransformerOptions(item, into);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (/DataFolderId$/.test(key) && typeof nested === 'string') into.add(nested);
    else collectDataFolderIdsInTransformerOptions(nested, into);
  }
}

/**
 * Decides, once per routine run, which Live Export engine runs it. The run-store engine is used only
 * when ALL of these hold; anything else runs classic, so a workbook that isn't a Live Export, or a
 * routine shape the run-store engine wasn't built for, can never take the new path:
 *
 * 1. the workbook is a Live Export (`managedBy = ws_export`);
 * 2. its settings ask for it (`live_export_engine = run_store`, set from Whalesync's developer options), and
 *    the `LIVE_EXPORT_RUN_STORE_ENGINE_DISABLED` kill switch is off;
 * 3. the routine is the Live Export shape: it starts with a discard (which creates the run store), then
 *    only pull / sync / publish steps, exactly one sync;
 * 4. every pull is a full pull (incremental destination pulls extend the previous run's snapshot, which
 *    a fresh-slate run store doesn't have);
 * 5. the pulls cover every folder the sync reads — its source and destination folders and every folder a
 *    transformer references (the run store holds only what this run pulled);
 * 6. the sync's mappings use no asset transformers (they need the Asset index and the rehost job).
 */
@Injectable()
export class LiveExportEngineService {
  constructor(
    private readonly db: DbService,
    private readonly experimentsService: ExperimentsService,
  ) {}

  async decideEngineForRoutineRun(args: {
    workbookId: string;
    routineRunId: string;
    steps: RoutineStepForEngineDecision[];
  }): Promise<LiveExportEngineDecision> {
    const decision = await this.decide(args);
    WSLogger.info({
      source: 'LiveExportEngineService',
      message: `Routine run ${args.routineRunId} uses the ${decision.engine} engine: ${decision.reason}`,
      workbookId: args.workbookId,
      routineRunId: args.routineRunId,
      engine: decision.engine,
    });
    return decision;
  }

  private async decide(args: {
    workbookId: string;
    steps: RoutineStepForEngineDecision[];
  }): Promise<LiveExportEngineDecision> {
    const classic = (reason: string): LiveExportEngineDecision => ({ engine: LiveExportEngine.CLASSIC, reason });

    const workbook = await this.db.client.workbook.findUnique({
      where: { id: args.workbookId },
      select: { managedBy: true, settings: true },
    });
    if (!workbook || workbook.managedBy !== WorkbookManager.WS_EXPORT) {
      return classic('not a Live Export workbook');
    }
    if (
      liveExportEngineRequestedBySettings(workbook.settings as WorkbookSettings | null) !== LiveExportEngine.RUN_STORE
    ) {
      return classic('the workbook settings do not ask for the run-store engine');
    }
    if (await this.experimentsService.getBooleanFlag(SystemFeatureFlag.LIVE_EXPORT_RUN_STORE_ENGINE_DISABLED, false)) {
      return classic('the LIVE_EXPORT_RUN_STORE_ENGINE_DISABLED kill switch is on');
    }

    if (args.steps.length === 0 || !isStepAction(args.steps[0], RoutineAction.DISCARD_PENDING_CHANGES)) {
      return classic('the routine does not start with a discard step');
    }
    const unsupportedStep = args.steps.find((step) => !ACTIONS_THE_RUN_STORE_ENGINE_HANDLES.has(step.action));
    if (unsupportedStep) {
      return classic(`the routine has a "${unsupportedStep.action}" step`);
    }
    const syncSteps = args.steps.filter((step) => isStepAction(step, RoutineAction.SYNC));
    if (syncSteps.length !== 1 || !syncSteps[0].syncId) {
      return classic(`the routine has ${syncSteps.length} sync steps (the run-store engine handles exactly one)`);
    }
    const incrementalPull = args.steps.find(
      (step) =>
        isStepAction(step, RoutineAction.PULL) && (step.options as { fullPull?: boolean } | null)?.fullPull !== true,
    );
    if (incrementalPull) {
      return classic('a pull step is incremental');
    }

    const syncId = syncSteps[0].syncId;
    // A direct read (rather than SyncService.getMappings) because routine execution can't depend on
    // SyncModule (SyncModule → ScheduleModule → RoutineExecutionModule is a cycle); the mappings still go
    // through the same v1/v2 choke-point parser SyncService uses.
    // eslint-disable-next-line no-restricted-syntax
    const syncRow = await this.db.client.sync.findUnique({ where: { id: syncId } });
    if (!syncRow) {
      return classic(`the sync ${syncId} no longer exists`);
    }
    const storedMappings = parseStoredMappings(syncRow).mappings;
    const mappings = storedMappings.version === 1 ? transformV1ToV2(storedMappings) : storedMappings;
    const usesAssetTransformers = mappings.tableMappings.some((tableMapping) =>
      tableMapping.columnMappings.some((columnMapping) =>
        ASSET_TRANSFORMER_TYPES.some(
          (transformerType) => findTransformerConfigsV2(columnMapping, transformerType).length > 0,
        ),
      ),
    );
    if (usesAssetTransformers) {
      return classic('the sync uses asset transformers');
    }

    const dataFolderIdsTheSyncReads = new Set<string>();
    for (const tableMapping of mappings.tableMappings) {
      dataFolderIdsTheSyncReads.add(tableMapping.sourceDataFolderId);
      dataFolderIdsTheSyncReads.add(tableMapping.destinationDataFolderId);
      for (const columnMapping of tableMapping.columnMappings) {
        collectDataFolderIdsInTransformerOptions(columnMapping, dataFolderIdsTheSyncReads);
      }
    }
    const pulledDataFolderIds = new Set(
      args.steps
        .filter((step) => isStepAction(step, RoutineAction.PULL))
        .flatMap((step) => step.pullDataFolderIds ?? []),
    );
    const unpulledDataFolderIds = [...dataFolderIdsTheSyncReads].filter((id) => !pulledDataFolderIds.has(id));
    if (unpulledDataFolderIds.length > 0) {
      return classic(`the sync reads folders no pull step pulls: ${unpulledDataFolderIds.join(', ')}`);
    }

    return { engine: LiveExportEngine.RUN_STORE, reason: 'requested by the workbook settings and supported' };
  }
}
