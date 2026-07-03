import { notifications } from '@mantine/notifications';
import { useCallback, useState } from 'react';
import {
  coerceCellInputTextAgainstExistingValueOrSchema,
  resolveSchemaLeafHint,
} from '../../../../../shared/cell-value-coercion';
import { getByPath } from '../../../../../shared/schema-columns';
import { trackApproveRecordChange, trackRejectRecordChange } from '../../../lib/posthog';
import { workspaceRelativePosixPath } from '../../../lib/workspace-relative-path';
import { applyAcceptedFieldChangeToFolderDiffData, type DiffGridResult } from '../diff-grid-types';
import { byTypeGroupKey, type ByTypeGroupModel } from './build-by-type-group-model';

/**
 * The review surface's action hook — every review-ladder mutation `FolderReviewSurface` can
 * trigger, in one place, lifted verbatim from `FolderDataGrid`'s call sites so both surfaces
 * touch the ladder identically (published → approved → local; a reject only walks the working
 * tree back). It owns the IPC that the host drives; the record-changes drawer keeps its own
 * per-record accept/reject IPC, so `handleRecordReviewed` here is the drawer's POST-review
 * refresh (never a second accept/reject call).
 *
 * Every mutation ends in the data hook's `bumpReviewDataVersion()` so the table and By-type
 * loads refresh together; record / group / folder-wide actions additionally invalidate
 * workspace-level data (publish counts, review stats). A cell edit deliberately does neither of
 * the workspace-wide refreshes — the optimistic apply already reflects it and re-validating every
 * connection for one cell would be wasteful (matches `FolderDataGrid`).
 */

export type BulkReviewAction = 'approve' | 'reject' | 'discard';

/** Analytics context for a drawer record review (rowStatus falls back to `'unknown'` off-page). */
export interface RecordReviewTrackProps {
  rowStatus: string;
  changedFieldCount: number;
}

const BULK_SUCCESS: Record<BulkReviewAction, { title: string; message: string }> = {
  approve: { title: 'All changes approved', message: 'Approved all pending changes.' },
  reject: { title: 'All changes rejected', message: 'Rejected all pending changes.' },
  discard: { title: 'All changes discarded', message: 'Discarded all pending and approved changes.' },
};

export interface UseReviewLadderActionsArgs {
  workspaceId: string;
  selectedFolderPath: string | null;
  workspacePath: string | null;
  schema: Record<string, unknown> | null;
  /** When the By-type set is truncated past the load cap, per-group bulk approve is unavailable. */
  byTypeIsTruncated: boolean;
  /** Refresh both diff loads after a mutation (from `useReviewSurfaceData`). */
  bumpReviewDataVersion: () => void;
  /** Apply an optimistic edit to the in-memory table diff before the IPC resolves. */
  applyOptimisticDiff: (updater: (prev: DiffGridResult) => DiffGridResult) => void;
  /** Bump workspace-level data (review stats, publish counts) after record / group / bulk actions. */
  invalidateWorkspaceLevelData: () => void;
}

export interface UseReviewLadderActions {
  /** A committed cell edit: coerce the raw text, apply optimistically, then persist. */
  editCell: (filename: string, fieldPath: string, inputText: string) => void;
  /** Per-group "Approve all N" for the By-type view (field group → column accept; record group → batch). */
  approveAllForGroup: (group: ByTypeGroupModel) => void;
  /** Group keys whose bulk approve is currently in flight (drives the spinner + disabled state). */
  approvingGroupKeys: ReadonlySet<string>;
  /** Folder-wide approve / reject / discard (the banner + subbar bulk actions). Resolves when done. */
  runBulkAction: (action: BulkReviewAction) => Promise<void>;
  /** True while a folder-wide bulk action is in flight. */
  bulkActionLoading: boolean;
  /**
   * The drawer's post-review refresh (Phase 7): the drawer already ran accept/reject, so this only
   * tracks the action and refreshes the surfaces + workspace counts. Stepper advance stays in the host.
   */
  handleRecordReviewed: (action: 'approve' | 'reject', trackProps: RecordReviewTrackProps) => void;
}

export function useReviewLadderActions({
  workspaceId,
  selectedFolderPath,
  workspacePath,
  schema,
  byTypeIsTruncated,
  bumpReviewDataVersion,
  applyOptimisticDiff,
  invalidateWorkspaceLevelData,
}: UseReviewLadderActionsArgs): UseReviewLadderActions {
  const [approvingGroupKeys, setApprovingGroupKeys] = useState<ReadonlySet<string>>(new Set());
  const [bulkActionLoading, setBulkActionLoading] = useState(false);

  const setGroupApproving = useCallback((groupKey: string, approving: boolean) => {
    setApprovingGroupKeys((prev) => {
      const next = new Set(prev);
      if (approving) next.add(groupKey);
      else next.delete(groupKey);
      return next;
    });
  }, []);

  const editCell = useCallback(
    (filename: string, fieldName: string, inputText: string) => {
      if (!selectedFolderPath || !workspacePath) return;

      // Apply optimistically before awaiting the IPC so the canvas never repaints the pre-edit value
      // in the gap between the overlay closing and the backend write. We interpret the typed text the
      // same way the main-process save path does (existing on-disk leaf wins; the JSON schema only
      // hints the scalar type of an empty leaf), so the optimistic value matches what lands on disk.
      const schemaHint = resolveSchemaLeafHint(schema, fieldName);
      applyOptimisticDiff((prev) => {
        const rowBeforeEdit = prev.rows.find((r) => r.__filename === filename);
        const existingValueAtFieldPath = rowBeforeEdit ? getByPath(rowBeforeEdit.__raw, fieldName) : undefined;
        const parsedValue = coerceCellInputTextAgainstExistingValueOrSchema(
          existingValueAtFieldPath,
          schemaHint,
          inputText,
        );
        return applyAcceptedFieldChangeToFolderDiffData(prev, filename, fieldName, parsedValue);
      });

      void window.scratchFiles
        .acceptFieldEditFromInputText(selectedFolderPath, workspacePath, filename, fieldName, inputText)
        .then(() => {
          // Keep the surface's unreviewed/approved markers honest without a full workspace revalidation.
          bumpReviewDataVersion();
        })
        .catch((err: unknown) => {
          console.error('[useReviewLadderActions] cell edit failed:', err);
          // On failure, refetch to resync with authoritative on-disk state rather than surgically revert;
          // any intervening edits on other cells are preserved that way.
          bumpReviewDataVersion();
          notifications.show({
            color: 'red',
            title: 'Failed to save cell',
            message: err instanceof Error ? err.message : 'Unknown error',
          });
        });
    },
    [applyOptimisticDiff, bumpReviewDataVersion, schema, selectedFolderPath, workspacePath],
  );

  // Per-group "Approve all N" (DEV-10618). A field group accepts the column's edit across the whole
  // folder in one CLI call (the effective leaf path); a created/removed/invalid group accepts its
  // records in one batched call. Disabled while the folder's pending set is truncated past the load cap.
  const approveAllForGroup = useCallback(
    (group: ByTypeGroupModel) => {
      if (!selectedFolderPath || !workspacePath || byTypeIsTruncated) return;
      const groupKey = byTypeGroupKey(group);
      if (approvingGroupKeys.has(groupKey)) return;
      setGroupApproving(groupKey, true);

      const finish = () => {
        setGroupApproving(groupKey, false);
        bumpReviewDataVersion();
        invalidateWorkspaceLevelData();
      };
      const fail = (err: unknown, title: string) => {
        console.error(`[useReviewLadderActions] ${title}`, err);
        notifications.show({ color: 'red', title, message: err instanceof Error ? err.message : 'Unknown error' });
      };

      if (group.kind === 'field' && group.effectivePath) {
        void window.scratchFiles
          .acceptFieldChanges(selectedFolderPath, workspacePath, group.effectivePath)
          .then((result) => {
            const fileCount = result.filesAccepted ?? result.paths.length;
            notifications.show({
              color: 'green',
              title: 'Changes approved',
              message: `Approved ${fileCount.toLocaleString()} change${fileCount === 1 ? '' : 's'} to "${group.title}".`,
            });
          })
          .catch((err: unknown) => fail(err, 'Failed to approve field'))
          .finally(finish);
        return;
      }

      const relativeFolderPath = workspaceRelativePosixPath(workspacePath, selectedFolderPath);
      if (!relativeFolderPath) {
        setGroupApproving(groupKey, false);
        return;
      }
      const recordPaths = group.recordFilenames.map((filename) => `${relativeFolderPath}/${filename}`);
      void window.scratchDesktop
        .acceptRecords(workspacePath, recordPaths)
        .then((result) => {
          if (result.exitCode !== 0) {
            throw new Error(result.stderr.trim() || result.stdout.trim() || 'Failed to approve records');
          }
          notifications.show({
            color: 'green',
            title: 'Changes approved',
            message: `Approved ${recordPaths.length.toLocaleString()} record${recordPaths.length === 1 ? '' : 's'}.`,
          });
        })
        .catch((err: unknown) => fail(err, 'Failed to approve records'))
        .finally(finish);
    },
    [
      selectedFolderPath,
      workspacePath,
      byTypeIsTruncated,
      approvingGroupKeys,
      setGroupApproving,
      bumpReviewDataVersion,
      invalidateWorkspaceLevelData,
    ],
  );

  const runBulkAction = useCallback(
    async (action: BulkReviewAction) => {
      if (!workspacePath) return;
      // Pass the absolute folder path straight through; the main process is the single place that
      // converts it to the CLI's workspace-relative form. A folder-scoped call covers every file in
      // the folder — not just the visible page.
      const folderPath = selectedFolderPath || undefined;

      setBulkActionLoading(true);
      try {
        const result =
          action === 'approve'
            ? await window.scratchDesktop.acceptAllChanges(workspacePath, folderPath)
            : action === 'discard'
              ? await window.scratchDesktop.discardAllChanges(workspacePath, folderPath)
              : await window.scratchDesktop.rejectAllChanges(workspacePath, folderPath);
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || result.stdout.trim() || `Failed to ${action} changes`);
        }
        notifications.show({ color: 'green', ...BULK_SUCCESS[action] });
        bumpReviewDataVersion();
        invalidateWorkspaceLevelData();
      } catch (err) {
        console.error(`[useReviewLadderActions] bulk ${action} failed:`, err);
        notifications.show({
          color: 'red',
          title: `Failed to ${action} changes`,
          message: err instanceof Error ? err.message : 'Unknown error',
        });
      } finally {
        setBulkActionLoading(false);
      }
    },
    [workspacePath, selectedFolderPath, bumpReviewDataVersion, invalidateWorkspaceLevelData],
  );

  const handleRecordReviewed = useCallback(
    (action: 'approve' | 'reject', trackProps: RecordReviewTrackProps) => {
      if (action === 'approve') void trackApproveRecordChange(workspaceId, trackProps);
      else void trackRejectRecordChange(workspaceId, trackProps);
      bumpReviewDataVersion();
      invalidateWorkspaceLevelData();
    },
    [workspaceId, bumpReviewDataVersion, invalidateWorkspaceLevelData],
  );

  return {
    editCell,
    approveAllForGroup,
    approvingGroupKeys,
    runBulkAction,
    bulkActionLoading,
    handleRecordReviewed,
  };
}
