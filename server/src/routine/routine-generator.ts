import { RoutineAction, RoutineStepOptions } from '@spinner/shared-types';
import { dump as dumpYaml } from 'js-yaml';
import { ROUTINES_DIRECTORY } from './routine-file-path';

/** Inputs needed to describe "how to run this sync" as a routine. */
export interface SyncRoutineSpec {
  /** The sync's displayName — rendered into the routine `name`. */
  syncDisplayName: string;
  /** The generated SyncId ("syn_...") the sync step targets. */
  syncId: string;
  /** Source-side connector account ids ("coa_..."); empty for a scratch-only source. */
  sourceConnectorAccountIds: string[];
  /** Destination-side connector account ids ("coa_..."); empty for a scratch-only destination. */
  destinationConnectorAccountIds: string[];
  /**
   * Destination connector account ids whose pull step should run INCREMENTAL instead of the
   * default full pull (see {@link FULL_PULL_STEP_OPTIONS} for why full is the default). Populated
   * only for users enrolled in `ENABLE_LIVE_EXPORT_INCREMENTAL_DESTINATION_PULL`; deletion
   * reconciliation on those destinations is knowingly skipped; their steps say `fullPull: false`
   * explicitly. Omitted/empty = every destination
   * pull is full.
   */
  incrementalPullDestinationConnectorAccountIds?: string[];
}

/** A routine file ready to hand to {@link RoutineService.createRoutineFile}. */
export interface GeneratedRoutineFile {
  path: string;
  content: string;
}

/**
 * The minimal on-disk shape of one generated routine step. We emit only the keys a generated step
 * ever sets (never `folder: null` / `sync: null`) because the routine YAML step schema is a
 * `z.strictObject` — a literal null on an unset optional would be rejected on re-parse.
 */
interface GeneratedRoutineStep {
  action: RoutineAction;
  name: string;
  connection?: string;
  sync?: string;
  comment?: string;
  options?: RoutineStepOptions;
}

/**
 * Every generated pull step is a FULL pull, on both the source and the destination side.
 *
 * A sync that mirrors deletions (`unmatchedDestinationPolicy.withMatchKey: 'delete'`) and a
 * destination that self-heals out-of-band drift both depend on the pull having reconciled
 * deletions — and only a full pull does that: `deleteStaleFiles` removes record files absent from
 * the pull, which is what turns an upstream deletion into a planned destination delete, and a
 * destination record that vanished (deleted, or archived out of Notion's `databases/query`) into a
 * planned re-create. An incremental pull deliberately skips that reconciliation because "absent"
 * is ambiguous there, and most services never surface a deletion in the incremental window at all.
 *
 * Routine pulls are incremental unless a step opts out, so a generated sync routine has to say so
 * explicitly — and the YAML the user reads then states the mode the sync depends on.
 *
 * The one exception is {@link SyncRoutineSpec.incrementalPullDestinationConnectorAccountIds}: a
 * flag-gated opt-in (`ENABLE_LIVE_EXPORT_INCREMENTAL_DESTINATION_PULL`) that leaves a destination
 * pull step incremental.
 */
const FULL_PULL_STEP_OPTIONS: RoutineStepOptions = { fullPull: true };

/**
 * The explicit opt-out: an incremental pull step says `fullPull: false` rather than omitting the
 * option, so the YAML a user reads states the mode either way (the executor treats an absent
 * option as incremental too, but "absent" reads like an oversight next to the full-pull steps).
 */
const INCREMENTAL_PULL_STEP_OPTIONS: RoutineStepOptions = { fullPull: false };

/**
 * Builds the routine that runs a sync end to end: clear any leftover working-set edits, pull every
 * source connection, pull every destination connection, run the sync, then publish to every
 * destination connection. PURE — no DB/git/IO — so it is trivially unit-testable and safe to import
 * anywhere (no Nest DI, no module-graph coupling).
 *
 * The first step is a pre-flight `discard-pending-changes`: it clears any leftover, never-published
 * working-set edits across the workbook so they can't pollute the pull → sync → publish that follows.
 * It targets no connection (it always clears the whole workbook) and is safe/idempotent.
 *
 * The file path is keyed on the SyncId (`routines/run-<syncId>.yaml`) so it is guaranteed valid
 * (a single file under `routines/`, no "..", no nested "/") and unique per sync.
 *
 * A connection-only pull step (no `folders`) means "pull all linked folders for that connection", and
 * every pull step is a full pull (see {@link FULL_PULL_STEP_OPTIONS}).
 * Step names must be unique within a routine (the parser enforces it): a bare "Pull Source" /
 * "Pull Destination" / "Publish to Destination" suffices when a side has a single connection; when
 * a side spans multiple connections we suffix the connector account id to keep names unique.
 *
 * A side with no connector accounts (a scratch folder whose `DataFolder.connectorAccountId` is null)
 * contributes no pull/publish steps — there is nothing remote to pull from or publish to there.
 */
export function buildSyncRoutineFile(spec: SyncRoutineSpec): GeneratedRoutineFile {
  const distinctSourceConnectorAccountIds = [...new Set(spec.sourceConnectorAccountIds)];
  const distinctDestinationConnectorAccountIds = [...new Set(spec.destinationConnectorAccountIds)];

  const steps: GeneratedRoutineStep[] = [];

  // Pre-flight cleanup runs FIRST: clear any leftover working-set edits so a stray, never-published
  // edit can't pollute the sync/publish below. Normal preparation — it doesn't touch published data.
  steps.push({
    action: RoutineAction.DISCARD_PENDING_CHANGES,
    name: 'Prepare workspace for sync',
    comment: 'Pre-flight: clear any leftover unpublished edits so the sync starts from a clean slate.',
  });

  for (const connectorAccountId of distinctSourceConnectorAccountIds) {
    steps.push({
      action: RoutineAction.PULL,
      name: distinctSourceConnectorAccountIds.length > 1 ? `Pull Source (${connectorAccountId})` : 'Pull Source',
      connection: connectorAccountId,
      options: FULL_PULL_STEP_OPTIONS,
    });
  }

  const incrementalPullDestinationConnectorAccountIdSet = new Set(
    spec.incrementalPullDestinationConnectorAccountIds ?? [],
  );
  for (const connectorAccountId of distinctDestinationConnectorAccountIds) {
    steps.push({
      action: RoutineAction.PULL,
      name:
        distinctDestinationConnectorAccountIds.length > 1
          ? `Pull Destination (${connectorAccountId})`
          : 'Pull Destination',
      connection: connectorAccountId,
      options: incrementalPullDestinationConnectorAccountIdSet.has(connectorAccountId)
        ? INCREMENTAL_PULL_STEP_OPTIONS
        : FULL_PULL_STEP_OPTIONS,
    });
  }

  steps.push({
    action: RoutineAction.SYNC,
    name: 'Run Sync',
    sync: spec.syncId,
  });

  for (const connectorAccountId of distinctDestinationConnectorAccountIds) {
    steps.push({
      action: RoutineAction.PUBLISH,
      name:
        distinctDestinationConnectorAccountIds.length > 1
          ? `Publish to Destination (${connectorAccountId})`
          : 'Publish to Destination',
      connection: connectorAccountId,
    });
  }

  const routine = {
    name: `Run Sync ${spec.syncDisplayName}`,
    steps,
  };

  // lineWidth: -1 disables line-wrapping (so long names/ids stay on one line); noRefs avoids YAML
  // anchors/aliases for repeated strings (e.g. the same coa id on a pull + publish step).
  const content = dumpYaml(routine, { lineWidth: -1, noRefs: true });

  return { path: `${ROUTINES_DIRECTORY}/run-${spec.syncId}.yaml`, content };
}
