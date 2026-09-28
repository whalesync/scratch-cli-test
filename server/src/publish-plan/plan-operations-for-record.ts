import { isScratchPendingPublishId } from '@spinner/shared-types';
import { ParsedContent, Schema } from 'src/utils/objects';
import { computeChangedFields } from './diff-utils';
import { RefCleanerService } from './ref-cleaner.service';
import { PhaseRequiringChangedFields, PublishPlanPhase } from './types';

/**
 * The per-record half of publish plan building: given one changed record, the plan operations it
 * needs. Shared by the classic plan build (which finds changed records by diffing git `main..dirty`,
 * `PublishPlanBuildService.buildPipeline`) and the Live Export run-store plan build (which reads the
 * sync's output from the run store), so both engines plan every record identically.
 */

/**
 * One plan operation, discriminated by phase: edit/backfill carry `changedFields` (the sparse partial
 * that gets PATCHed); the other phases never use it.
 */
export type PlanOperation =
  | {
      phase: PhaseRequiringChangedFields;
      filePath: string;
      content: ParsedContent;
      changedFields: Record<string, unknown>;
      remoteRecordId?: string | null;
      dataFolderId?: string | null;
      status: string;
      isRecreate?: boolean;
    }
  | {
      phase: Exclude<PublishPlanPhase, PhaseRequiringChangedFields>;
      filePath: string;
      content: ParsedContent;
      remoteRecordId?: string | null;
      dataFolderId?: string | null;
      status: string;
      isRecreate?: boolean;
    };

/**
 * Edit-phase operations for a record that exists remotely: an `edit` when anything changed, plus a
 * `backfill` for references that can only be written after the create phase (pseudo-refs, asset
 * refs, revert FK literals). Empty when nothing needs publishing.
 *
 * @param contentObj the record's new content (dirty), parsed
 * @param readPublishedContentForDiff the record's published content (main), parsed; null when absent or
 *   unreadable. Called only when an operation is emitted.
 * @param isUserModified the record itself changed (vs. only touched because it references a deleted record)
 */
export function planEditOperationsForRecord(args: {
  refCleanerService: RefCleanerService;
  filePath: string;
  contentObj: ParsedContent;
  readPublishedContentForDiff: () => Record<string, unknown> | null;
  schema: Schema;
  dataFolderId: string | undefined;
  deletedRecordIds: Set<string>;
  isRecreatePath: boolean;
  isUserModified: boolean;
  /** Set on the edit/backfill ops so dispatch needs no id lookup; classic leaves it unset. */
  remoteRecordId?: string | null;
}): PlanOperation[] {
  const {
    refCleanerService,
    filePath,
    contentObj,
    readPublishedContentForDiff,
    schema,
    dataFolderId,
    deletedRecordIds,
    isRecreatePath,
    isUserModified,
  } = args;
  const planOperations: PlanOperation[] = [];
  const remoteRecordIdFields = args.remoteRecordId !== undefined ? { remoteRecordId: args.remoteRecordId } : {};

  // --- THREE PASS STRIPPING ---

  // Pass 1: Strip references to DELETED records.
  const pass1ContentObj = refCleanerService.stripDeletedRecordRefs(contentObj, schema, deletedRecordIds);
  const pass1ContentStr = JSON.stringify(pass1ContentObj, null, 2);

  // Pass 2: Strip references to NEW records (Pseudo-refs).
  const pass2ContentObj = refCleanerService.stripPseudoRefs(pass1ContentObj, schema);
  const pass2ContentStr = JSON.stringify(pass2ContentObj, null, 2);

  // Pass 3: Strip @asset/ pseudo-refs (schema-agnostic).
  const pass3ContentObj = refCleanerService.stripAssetPseudoRefs(pass2ContentObj);
  const pass3ContentStr = JSON.stringify(pass3ContentObj, null, 2);

  // Pass 4: Strip ALL literal FK fields for revert-edits. The
  // backfill phase reattaches them via RecreatedIdMap once every
  // co-reverted parent's new id is known. For non-revert edits this
  // is the identity (pass4 = pass3); the strip is gated on the
  // path's presence in `revertPaths` (UploadPatchMeta.revert=true).
  const pass4ContentObj = isRecreatePath
    ? refCleanerService.nullifyAllForeignKeyFields(pass3ContentObj, schema)
    : pass3ContentObj;
  const pass4ContentStr = isRecreatePath ? JSON.stringify(pass4ContentObj, null, 2) : pass3ContentStr;

  // Determine Edit Operation
  const originalContentStr = JSON.stringify(contentObj, null, 2);
  const isRefCleared = pass1ContentStr !== originalContentStr;
  const isPseudoStripped = pass2ContentStr !== pass1ContentStr;
  const isAssetStripped = pass3ContentStr !== pass2ContentStr;
  const isRevertFkStripped = pass4ContentStr !== pass3ContentStr;

  if (isUserModified || isRefCleared || isPseudoStripped || isAssetStripped || isRevertFkStripped) {
    // Compute changedFields by diffing main vs dirty (after stripping).
    // A main copy that's absent or unreadable (DEV-9981) diffs the record as
    // fully-changed (non-destructive: publishes more, loses nothing).
    const mainObj = readPublishedContentForDiff();
    const changed = mainObj
      ? computeChangedFields(mainObj, pass4ContentObj as Record<string, unknown>, schema)
      : (pass4ContentObj as Record<string, unknown>);

    // For revert-edits whose ONLY changes were FK fields (all
    // stripped by pass4 → moved to backfill), the resulting edit
    // changedFields collapses to {}. Skip emission in that case —
    // the backfill op below carries the real work and an empty
    // edit op would be a wasted no-op connector call. For non-
    // revert edits we preserve the existing behavior of emitting
    // even when changedFields is {} (downstream uses the op as a
    // "this file was touched" signal regardless of diff content).
    const skipEmptyRevertEdit = isRecreatePath && Object.keys(changed).length === 0;
    if (!skipEmptyRevertEdit) {
      planOperations.push({
        filePath,
        phase: 'edit',
        content: pass4ContentObj,
        changedFields: changed,
        dataFolderId: dataFolderId || null,
        status: 'pending',
        isRecreate: isRecreatePath,
        ...remoteRecordIdFields,
      });
    }

    // Backfill Logic — backfill if pseudo-refs, asset-refs, OR revert
    // FK literals were stripped. `pass4 !== pass1` covers all three.
    if (pass4ContentStr !== pass1ContentStr) {
      // changedFields for backfill: diff between fully-stripped (pass4) and pre-pseudo (pass1)
      const backfillChanged = computeChangedFields(
        pass4ContentObj as Record<string, unknown>,
        pass1ContentObj as Record<string, unknown>,
      );

      planOperations.push({
        filePath,
        phase: 'backfill',
        content: pass1ContentObj,
        changedFields: backfillChanged,
        dataFolderId: dataFolderId || null,
        status: 'pending',
        isRecreate: isRecreatePath,
        ...remoteRecordIdFields,
      });
    }
  }
  return planOperations;
}

/**
 * Create-phase operations for a record that doesn't exist remotely yet: the `create`, a
 * `rename-files` when the record's filename is still a pending-publish id (classic only — the run
 * store has no filenames to fix up), and a `backfill` for references that can only be written once
 * the create phase has run.
 */
export function planCreateOperationsForRecord(args: {
  refCleanerService: RefCleanerService;
  filePath: string;
  filename: string;
  contentObj: ParsedContent;
  schema: Schema;
  dataFolderId: string | undefined;
  deletedRecordIds: Set<string>;
  isRecreatePath: boolean;
  includeRenameFilesOperation: boolean;
}): PlanOperation[] {
  const {
    refCleanerService,
    filePath,
    filename,
    contentObj,
    schema,
    dataFolderId,
    deletedRecordIds,
    isRecreatePath,
    includeRenameFilesOperation,
  } = args;
  const planOperations: PlanOperation[] = [];

  // Pass 1: Strip Deleted
  const pass1ContentObj = refCleanerService.stripDeletedRecordRefs(contentObj, schema, deletedRecordIds);
  const pass1ContentStr = JSON.stringify(pass1ContentObj, null, 2);

  // Pass 2: Strip Pseudo
  const pass2ContentObj = refCleanerService.stripPseudoRefs(pass1ContentObj, schema);

  // Pass 3: Strip @asset/ pseudo-refs
  const pass3ContentObj = refCleanerService.stripAssetPseudoRefs(pass2ContentObj);
  const pass3ContentStr = JSON.stringify(pass3ContentObj, null, 2);

  // Pass 4: Strip ALL literal FK fields for revert-creates. The
  // CREATE op is dispatched without FK fields (so the connector's FK
  // constraint can't trip on a parent whose new id is still pending
  // from a sibling revert in the same plan); the backfill op below
  // carries the literal prior ids that get resolved against
  // RecreatedIdMap after every create lands.
  const pass4ContentObj = isRecreatePath
    ? refCleanerService.nullifyAllForeignKeyFields(pass3ContentObj, schema)
    : pass3ContentObj;
  const pass4ContentStr = isRecreatePath ? JSON.stringify(pass4ContentObj, null, 2) : pass3ContentStr;

  planOperations.push({
    filePath,
    phase: 'create',
    content: pass4ContentObj,
    dataFolderId: dataFolderId || null,
    status: 'pending',
    isRecreate: isRecreatePath,
  });

  if (includeRenameFilesOperation && isScratchPendingPublishId(filename)) {
    planOperations.push({
      filePath,
      phase: 'rename-files',
      content: {},
      dataFolderId: dataFolderId || null,
      status: 'pending',
    });
  }

  if (pass4ContentStr !== pass1ContentStr) {
    // The create above sent pass4 (all deferred refs + revert-FK
    // literals stripped). Anything that differs in pass1 is a ref
    // that got stripped and now needs to be written back once the
    // create phase has run — that's exactly what this backfill is
    // for. The diff (pass4 vs pass1) gives us the keys that were
    // stripped, which is the sparse partial the connector should
    // PATCH.
    //
    // Three categories of fields can show up here:
    //   - pseudo-refs (`@/path.json`) → resolved at dispatch via
    //     file_index after the referenced create lands
    //   - asset-refs (`@asset/<id>`) → resolved via Asset table
    //   - literal FK ids on revert-creates → resolved via
    //     RecreatedIdMap (only fires when isRecreate=true)
    //
    // Example (forward case): user creates an article referencing
    // a co-pending author.
    //   pass1: { title: 'Hi', authorId: '@/people/jane.json', cover: '@asset/x' }
    //   pass4: { title: 'Hi', authorId: null,                 cover: null       }
    //   create posts pass4 (Jane's id and the asset id aren't known yet).
    //   diff(pass4, pass1) => { authorId: '@/people/jane.json', cover: '@asset/x' }
    //   the publish runner later resolves those refs and PATCHes the new record.
    const backfillChanged = computeChangedFields(
      pass4ContentObj as Record<string, unknown>,
      pass1ContentObj as Record<string, unknown>,
    );
    planOperations.push({
      filePath,
      phase: 'backfill',
      content: pass1ContentObj,
      changedFields: backfillChanged,
      dataFolderId: dataFolderId || null,
      status: 'pending',
      isRecreate: isRecreatePath,
    });
  }
  return planOperations;
}
