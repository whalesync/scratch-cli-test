import { Box, Group, Loader, Portal, ScrollArea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, Trash2, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getByPath } from '../../../../shared/schema-columns';
import { ButtonPrimarySolid, ButtonSecondaryGhost, IconButtonGhost } from '../../components/base/buttons';
import {
  Text12Medium,
  Text12Regular,
  Text13Regular,
  TextMono12Regular,
  TextMono9Regular,
  TextTitle2,
} from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { workspaceRelativePosixPath } from '../../lib/workspace-relative-path';
import { isLongFormContent } from './content-paragraph-diff';
import { ContentDiffWithMap } from './ContentDiffWithMap';
import { FieldReviewActions } from './diff-renderers';
import {
  applyAcceptedFieldChangeToOpenRecordData,
  getRecordName,
  rowHasUnreviewedChanges,
  toDisplayString,
  type DiffRecordData,
  type DiffRowStatus,
} from './record-diff-helpers';

interface RecordReviewDrawerProps {
  folderPath: string;
  workspacePath: string;
  titleColumnId: string | null;
  /** Map from column id to display label (e.g. "title" → "Title"). */
  columnLabels?: Map<string, string>;
  /** Map from column id to subfield-aware effective path (e.g. "title" → "title.raw"). */
  columnEffectivePaths?: Map<string, string>;
  /** Ordered filenames (grid order) of the records the drawer steps through. */
  changedFilenames: string[];
  /** Index into `changedFilenames` of the record currently shown. */
  currentIndex: number;
  /** Step the drawer to another record in the set (the header ↑/↓ stepper and arrow keys). */
  onSelectIndex: (index: number) => void;
  onClose: () => void;
  /** Called after a successful record-level approve; the parent advances and refreshes the grid. */
  onApproved: (filename: string) => void;
  /** Called after a successful record-level reject; the parent advances and refreshes the grid. */
  onRejected: (filename: string) => void;
  /** Optimistically apply a single accepted field to the grid diff (mirrors RecordDetailView). */
  onSingleFieldAccepted?: (filename: string, fieldName: string, nextValue: unknown) => void;
  /** A per-field reject changed the record's structure — the host refetches both surfaces. */
  onFieldReviewedRefetchAll?: () => void;
}

interface StateBadge {
  label: string;
  backgroundColor: string;
  foregroundColor: string;
}

/** State pill shown in the title block, keyed exhaustively by row status so a new status can't slip through untyped. */
const STATE_BADGE_BY_ROW_STATUS: Record<DiffRowStatus, StateBadge> = {
  added: {
    label: 'NEW',
    backgroundColor: 'var(--create-needs-review-bg)',
    foregroundColor: 'var(--create-needs-review-stroke)',
  },
  addedUnpublished: {
    label: 'NEW',
    backgroundColor: 'var(--create-approved-bg)',
    foregroundColor: 'var(--create-approved-stroke)',
  },
  modified: {
    label: 'MODIFIED',
    backgroundColor: 'var(--modified-needs-review-bg)',
    foregroundColor: 'var(--modified-needs-review-stroke)',
  },
  unpublished: {
    label: 'MODIFIED',
    backgroundColor: 'var(--modified-approved-bg)',
    foregroundColor: 'var(--modified-approved-stroke)',
  },
  deleted: {
    label: 'REMOVED',
    backgroundColor: 'var(--delete-needs-review-bg)',
    foregroundColor: 'var(--delete-needs-review-stroke)',
  },
  deletedUnpublished: {
    label: 'REMOVED',
    backgroundColor: 'var(--delete-approved-bg)',
    foregroundColor: 'var(--delete-approved-stroke)',
  },
  unchanged: { label: 'UNCHANGED', backgroundColor: 'var(--bg-selected)', foregroundColor: 'var(--fg-muted)' },
  invalidJson: {
    label: 'INVALID',
    backgroundColor: 'var(--delete-needs-review-bg)',
    foregroundColor: 'var(--delete-needs-review-stroke)',
  },
};

const EMPTY_VALUE_PLACEHOLDER = '(empty)';

/** Which fields the body shows: only the changed ones, or every column and its value. */
type DrawerFieldMode = 'changes' | 'all';

/**
 * Shared shell for a single field block: an uppercase mono field label (with optional per-field
 * review actions on the right) above the field's diff/value content, with the divider/padding chrome.
 */
function FieldBlockShell({
  label,
  actions,
  children,
}: {
  label: string;
  actions?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <Box style={{ borderTop: '0.5px solid var(--fg-divider)', padding: '12px 0' }}>
      <Group justify="space-between" align="flex-start" wrap="nowrap" style={{ marginBottom: 6, gap: 8 }}>
        <TextMono12Regular
          c="var(--fg-muted)"
          style={{ textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block' }}
        >
          {label}
        </TextMono12Regular>
        {actions}
      </Group>
      {children}
    </Box>
  );
}

/**
 * A single changed field rendered under an uppercase mono label. For modified records it shows the
 * approved value struck through, an arrow, then the new local value; for created records only the
 * new value. `actions` renders the per-field Approve / Reject controls when the field is reviewable.
 */
function ChangedFieldBlock({
  label,
  fromValue,
  toValue,
  kind,
  actions,
}: {
  label: string;
  fromValue?: string;
  toValue: string;
  kind: 'modified' | 'created';
  actions?: ReactNode;
}): ReactNode {
  return (
    <FieldBlockShell label={label} actions={actions}>
      {kind === 'modified' ? (
        <Group gap={8} align="baseline" wrap="wrap">
          <Text13Regular
            c="var(--delete-needs-review-stroke)"
            style={{ textDecoration: 'line-through', wordBreak: 'break-word' }}
          >
            {fromValue && fromValue.length > 0 ? fromValue : EMPTY_VALUE_PLACEHOLDER}
          </Text13Regular>
          <StyledLucideIcon Icon={ArrowRight} size="sm" c="var(--fg-muted)" />
          <Text13Regular c="var(--create-needs-review-stroke)" style={{ wordBreak: 'break-word' }}>
            {toValue && toValue.length > 0 ? toValue : EMPTY_VALUE_PLACEHOLDER}
          </Text13Regular>
        </Group>
      ) : (
        <Text13Regular c="var(--create-needs-review-stroke)" style={{ wordBreak: 'break-word' }}>
          {toValue && toValue.length > 0 ? toValue : EMPTY_VALUE_PLACEHOLDER}
        </Text13Regular>
      )}
    </FieldBlockShell>
  );
}

/** A plain (unchanged) field: its label and current value, no review actions. */
function PlainFieldBlock({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <FieldBlockShell label={label}>
      <Text13Regular
        c={value.length > 0 ? 'var(--fg-secondary)' : 'var(--fg-muted)'}
        style={{ wordBreak: 'break-word' }}
      >
        {value.length > 0 ? value : EMPTY_VALUE_PLACEHOLDER}
      </Text13Regular>
    </FieldBlockShell>
  );
}

/** The footer "Changes / All fields" segmented toggle. */
function FieldModeToggle({
  mode,
  onChange,
}: {
  mode: DrawerFieldMode;
  onChange: (mode: DrawerFieldMode) => void;
}): ReactNode {
  const options: { value: DrawerFieldMode; label: string }[] = [
    { value: 'changes', label: 'Changes' },
    { value: 'all', label: 'All fields' },
  ];
  return (
    <Box style={{ display: 'inline-flex', gap: 2, border: '1px solid var(--fg-divider)', borderRadius: 4, padding: 1 }}>
      {options.map(({ value, label }) => {
        const active = mode === value;
        return (
          <Box
            key={value}
            component="button"
            aria-label={label}
            aria-pressed={active}
            onClick={() => onChange(value)}
            style={{
              padding: '2px 10px',
              border: 'none',
              borderRadius: 3,
              backgroundColor: active ? 'var(--highlight-fill)' : 'transparent',
              outline: active ? '1px solid var(--highlight-border)' : 'none',
              cursor: active ? 'default' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              lineHeight: 1,
            }}
          >
            <Text12Medium
              c={active ? 'var(--highlight-text)' : 'var(--fg-muted)'}
              fw={active ? 500 : undefined}
              component="span"
            >
              {label}
            </Text12Medium>
          </Box>
        );
      })}
    </Box>
  );
}

/**
 * The v2 review surface's right-side record panel. Steps through a set of records (grid order),
 * showing either just a record's changed fields or every column and its value (the bottom toggle;
 * a record with nothing to review opens in All-fields mode). Changed fields carry per-field
 * Approve / Reject (mirroring RecordDetailView) alongside the record-level Approve / Reject footer.
 */
export const RecordReviewDrawer = memo(function RecordReviewDrawer({
  folderPath,
  workspacePath,
  titleColumnId,
  columnLabels,
  columnEffectivePaths,
  changedFilenames,
  currentIndex,
  onSelectIndex,
  onClose,
  onApproved,
  onRejected,
  onSingleFieldAccepted,
  onFieldReviewedRefetchAll,
}: RecordReviewDrawerProps) {
  const [recordData, setRecordData] = useState<DiffRecordData | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldMode, setFieldMode] = useState<DrawerFieldMode>('changes');
  // Bumped after a per-field reject to reload this record's three-state diff from disk.
  const [reloadTick, setReloadTick] = useState(0);
  // In-session approve/reject markers, keyed by filename. The grid refetch removes
  // an approved/rejected record from the changed set; until that lands (or if the
  // user wraps back to it) this lets the title block show the ✓/✕ marker.
  const [sessionMarkerByFilename, setSessionMarkerByFilename] = useState<Record<string, 'approved' | 'rejected'>>({});
  const loadedRecordKeyRef = useRef<string | null>(null);
  // Whether the initial default field-mode has been applied for this drawer instance. The default
  // (a record with nothing to review opens in All-fields mode) is applied only to the FIRST record
  // shown; after that the chosen mode persists as the user cycles / approves / rejects records.
  const hasDefaultedFieldModeRef = useRef(false);

  const changedRecordCount = changedFilenames.length;
  const currentFilename = changedFilenames[currentIndex] ?? null;

  // Load the current record's three-state diff. Keyed on the filename value (not the
  // changedFilenames array reference) so a grid refetch that produces a new array but
  // keeps the same current record does not trigger a redundant reload; `reloadTick`
  // forces a reload in place after a per-field reject.
  useEffect(() => {
    if (!currentFilename) {
      setRecordData(null);
      return;
    }
    let cancelled = false;
    const recordKey = `${workspacePath}::${folderPath}::${currentFilename}`;
    if (loadedRecordKeyRef.current !== recordKey) {
      setLoading(true);
    }
    void window.scratchFiles
      .readDiffRecordData(folderPath, workspacePath, currentFilename)
      .then((result) => {
        if (cancelled) return;
        setRecordData(result);
        loadedRecordKeyRef.current = recordKey;
        // Only the first record shown sets the default mode; cycling/approve/reject keep the
        // user's current Changes / All fields choice.
        if (!hasDefaultedFieldModeRef.current) {
          hasDefaultedFieldModeRef.current = true;
          setFieldMode(rowHasUnreviewedChanges(result?.row) ? 'changes' : 'all');
        }
      })
      .catch(() => {
        if (cancelled) return;
        setRecordData(null);
        loadedRecordKeyRef.current = null;
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [currentFilename, folderPath, workspacePath, reloadTick]);

  const stepBy = useCallback(
    (delta: number) => {
      if (changedRecordCount === 0) return;
      onSelectIndex((currentIndex + delta + changedRecordCount) % changedRecordCount);
    },
    [changedRecordCount, currentIndex, onSelectIndex],
  );

  // While the drawer is open: ↑/↓ cycle between records (wrapping), Esc closes.
  // Capture phase so the grid underneath doesn't also move its cell selection.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.isContentEditable) return;
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      }
      if (changedRecordCount === 0) return;
      event.preventDefault();
      event.stopPropagation();
      stepBy(event.key === 'ArrowUp' ? -1 : 1);
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [changedRecordCount, onClose, stepBy]);

  const rowStatus: DiffRowStatus = recordData?.row.__rowStatus ?? 'modified';
  const isDeletedRecord = rowStatus === 'deleted' || rowStatus === 'deletedUnpublished';
  const recordName = recordData
    ? getRecordName(recordData.row, titleColumnId)
    : (currentFilename ?? '').replace(/\.json$/, '');
  const badge = STATE_BADGE_BY_ROW_STATUS[rowStatus];
  const sessionMarker = currentFilename ? sessionMarkerByFilename[currentFilename] : undefined;

  // Reverse map (effective path → column id) so a changed leaf path like "title.raw"
  // can recover the column's display label ("Title").
  const columnIdByEffectivePath = useMemo(() => {
    const map = new Map<string, string>();
    columnEffectivePaths?.forEach((effectivePath, columnId) => map.set(effectivePath, columnId));
    return map;
  }, [columnEffectivePaths]);

  const labelForChangedField = useCallback(
    (fieldPath: string): string => {
      const directLabel = columnLabels?.get(fieldPath);
      if (directLabel) return directLabel;
      const columnId = columnIdByEffectivePath.get(fieldPath);
      if (columnId) {
        const columnLabel = columnLabels?.get(columnId);
        if (columnLabel) return columnLabel;
      }
      return fieldPath;
    },
    [columnLabels, columnIdByEffectivePath],
  );

  // ── Per-field review (accept / reject one changed field), mirroring RecordDetailView ──
  const approveField = useCallback(
    (fieldPath: string, value: string) => {
      if (!currentFilename || busy) return;
      const filenameForAction = currentFilename;
      setBusy(true);
      void window.scratchFiles
        .acceptUnreviewedFieldEdit(folderPath, workspacePath, filenameForAction, fieldPath, value)
        .then((result) => {
          setRecordData((prev) =>
            prev ? applyAcceptedFieldChangeToOpenRecordData(prev, fieldPath, result.value) : prev,
          );
          onSingleFieldAccepted?.(filenameForAction, fieldPath, result.value);
        })
        .catch((err: unknown) => {
          console.error('[acceptUnreviewedFieldEdit] approve field failed:', err);
          notifications.show({
            color: 'red',
            title: 'Failed to approve field',
            message: err instanceof Error ? err.message : 'Unknown error',
          });
        })
        .finally(() => setBusy(false));
    },
    [busy, currentFilename, folderPath, workspacePath, onSingleFieldAccepted],
  );

  const rejectField = useCallback(
    (fieldPath: string) => {
      if (!currentFilename || busy) return;
      setBusy(true);
      void window.scratchFiles
        .revertUnreviewedFieldEditToApproved(folderPath, workspacePath, currentFilename, fieldPath)
        .then(() => {
          setReloadTick((tick) => tick + 1);
          onFieldReviewedRefetchAll?.();
        })
        .catch((err: unknown) => {
          console.error('[revertUnreviewedFieldEditToApproved] reject field failed:', err);
          notifications.show({
            color: 'red',
            title: 'Failed to reject field',
            message: err instanceof Error ? err.message : 'Unknown error',
          });
        })
        .finally(() => setBusy(false));
    },
    [busy, currentFilename, folderPath, workspacePath, onFieldReviewedRefetchAll],
  );

  // A single changed field's block (diff + per-field Approve / Reject). `effectivePath` is the leaf
  // key used both to read the value and as the field name for the accept/reject IPC.
  const renderChangedFieldBlock = useCallback(
    (key: string, label: string, effectivePath: string): ReactNode => {
      if (!recordData) return null;
      const displayData = recordData.displayData ?? {};
      const fromValue = toDisplayString(recordData.row.__fromFields[effectivePath]);
      const toValue = toDisplayString(getByPath(displayData, effectivePath));
      const actions = (
        <FieldReviewActions
          diffKind="unreviewed"
          onApprove={busy ? undefined : () => approveField(effectivePath, toValue)}
          onUndo={busy ? undefined : () => rejectField(effectivePath)}
        />
      );
      // Long-form bodies (multi-paragraph descriptions) read terribly as a single struck-through
      // block, so route them to the rich paragraph diff + minimap; short fields stay compact.
      if (isLongFormContent(fromValue, toValue)) {
        return (
          <FieldBlockShell key={key} label={label} actions={actions}>
            <ContentDiffWithMap fromValue={fromValue} toValue={toValue} diffKind="unreviewed" />
          </FieldBlockShell>
        );
      }
      return (
        <ChangedFieldBlock
          key={key}
          label={label}
          fromValue={fromValue}
          toValue={toValue}
          kind="modified"
          actions={actions}
        />
      );
    },
    [recordData, busy, approveField, rejectField],
  );

  // Changed-only view: one block per unreviewed field, each with Approve / Reject.
  const changedFieldBlocks = useMemo<ReactNode[]>(() => {
    if (!recordData) return [];
    return recordData.row.__changedFields.map((fieldPath) =>
      renderChangedFieldBlock(fieldPath, labelForChangedField(fieldPath), fieldPath),
    );
  }, [recordData, labelForChangedField, renderChangedFieldBlock]);

  // Created-record view: the new record's non-empty field values (record-level review only).
  const createdFieldBlocks = useMemo<ReactNode[]>(() => {
    if (!recordData) return [];
    const displayData = recordData.displayData ?? {};
    return recordData.columns
      .map((column) => ({ column, value: toDisplayString(getByPath(displayData, column.id)) }))
      .filter(({ value }) => value.length > 0)
      .map(({ column, value }) => (
        <ChangedFieldBlock
          key={column.id}
          label={columnLabels?.get(column.id) ?? column.displayName ?? column.id}
          toValue={value}
          kind="created"
        />
      ));
  }, [recordData, columnLabels]);

  // All-fields view: every column and its value; changed columns render their diff + Approve/Reject.
  const allFieldBlocks = useMemo<ReactNode[]>(() => {
    if (!recordData) return [];
    const displayData = recordData.displayData ?? {};
    const changedEffectivePaths = new Set(recordData.row.__changedFields);
    const isReviewableRecord = rowStatus === 'modified' || rowStatus === 'unpublished';
    return recordData.columns.map((column) => {
      const effectivePath = columnEffectivePaths?.get(column.id) ?? column.id;
      const label = columnLabels?.get(column.id) ?? column.displayName ?? column.id;
      if (isReviewableRecord && changedEffectivePaths.has(effectivePath)) {
        return renderChangedFieldBlock(column.id, label, effectivePath);
      }
      return (
        <PlainFieldBlock key={column.id} label={label} value={toDisplayString(getByPath(displayData, effectivePath))} />
      );
    });
  }, [recordData, rowStatus, columnEffectivePaths, columnLabels, renderChangedFieldBlock]);

  const runRecordAction = useCallback(
    (action: 'approve' | 'reject') => {
      if (!currentFilename || busy) return;
      const relativeFolderPath = workspaceRelativePosixPath(workspacePath, folderPath);
      if (!relativeFolderPath) return;
      const recordCliPath = `${relativeFolderPath}/${currentFilename}`;
      const filenameForAction = currentFilename;
      setBusy(true);
      const ipcCall =
        action === 'approve'
          ? window.scratchDesktop.acceptRecord(workspacePath, recordCliPath)
          : window.scratchDesktop.rejectRecord(workspacePath, recordCliPath);
      void ipcCall
        .then((result) => {
          if (result.exitCode !== 0) {
            throw new Error(
              result.stderr.trim() ||
                result.stdout.trim() ||
                `Failed to ${action === 'approve' ? 'approve' : 'reject'} record`,
            );
          }
          setSessionMarkerByFilename((markers) => ({
            ...markers,
            [filenameForAction]: action === 'approve' ? 'approved' : 'rejected',
          }));
          if (action === 'approve') onApproved(filenameForAction);
          else onRejected(filenameForAction);
        })
        .catch((err: unknown) => {
          console.error(`${action}Record failed`, err);
          notifications.show({
            color: 'red',
            title: `Failed to ${action === 'approve' ? 'approve' : 'reject'} record`,
            message: err instanceof Error ? err.message : 'Unknown error',
          });
        })
        .finally(() => setBusy(false));
    },
    [busy, currentFilename, folderPath, onApproved, onRejected, workspacePath],
  );

  let bodyContent: ReactNode = null;
  if (recordData) {
    if (rowStatus === 'invalidJson') {
      bodyContent = (
        <Box style={{ padding: '12px 0' }}>
          <Text13Regular c="var(--mantine-color-orange-8)" style={{ whiteSpace: 'pre-wrap' }}>
            {recordData.row.__parseError && recordData.row.__parseError.length > 0
              ? recordData.row.__parseError
              : 'This record file is not valid JSON on disk.'}
          </Text13Regular>
        </Box>
      );
    } else if (isDeletedRecord) {
      bodyContent = (
        <Group gap={8} align="flex-start" wrap="nowrap" style={{ padding: '12px 0' }}>
          <StyledLucideIcon Icon={Trash2} size="sm" c="var(--delete-needs-review-stroke)" />
          <Text13Regular c="var(--fg-secondary)">
            {rowStatus === 'deleted'
              ? 'This record was removed at the source. Approving will delete it in the destination service on the next publish.'
              : 'This record is approved for deletion and will be removed on the next publish.'}
          </Text13Regular>
        </Group>
      );
    } else if (fieldMode === 'all') {
      bodyContent = allFieldBlocks.length > 0 ? <>{allFieldBlocks}</> : <PlainFieldBlock label="" value="" />;
    } else if (rowStatus === 'added' || rowStatus === 'addedUnpublished') {
      bodyContent =
        createdFieldBlocks.length > 0 ? (
          <>{createdFieldBlocks}</>
        ) : (
          <Box style={{ padding: '12px 0' }}>
            <Text13Regular c="var(--fg-muted)">This new record has no field values yet.</Text13Regular>
          </Box>
        );
    } else {
      bodyContent =
        changedFieldBlocks.length > 0 ? (
          <>{changedFieldBlocks}</>
        ) : (
          <Box style={{ padding: '12px 0' }}>
            <Text13Regular c="var(--fg-muted)">No field changes to review.</Text13Regular>
          </Box>
        );
    }
  }

  const rejectButtonLabel = isDeletedRecord ? 'Keep record' : 'Reject';
  const approveButtonLabel = changedRecordCount > 1 ? 'Approve · next →' : 'Approve';
  const hasRecordLevelReview = rowHasUnreviewedChanges(recordData?.row);

  return (
    <Portal target="#portal">
      <Box
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(33, 37, 41, 0.28)',
          zIndex: 10050,
          display: 'flex',
          justifyContent: 'flex-end',
        }}
      >
        <Box
          onClick={(event) => event.stopPropagation()}
          style={{
            position: 'relative',
            width: 960,
            maxWidth: '92vw',
            height: '100%',
            backgroundColor: 'var(--bg-base)',
            borderLeft: '0.5px solid var(--fg-divider)',
            boxShadow: '-12px 0 40px rgba(0, 0, 0, 0.18)',
            display: 'flex',
            flexDirection: 'column',
            zIndex: 10051,
          }}
        >
          {/* Header */}
          <Group
            justify="space-between"
            align="center"
            wrap="nowrap"
            style={{ padding: '8px 12px', borderBottom: '0.5px solid var(--fg-divider)' }}
          >
            <ButtonSecondaryGhost
              size="compact-xs"
              leftSection={<StyledLucideIcon Icon={ArrowLeft} size="sm" />}
              onClick={onClose}
            >
              All changes
            </ButtonSecondaryGhost>
            <Group gap={6} align="center" wrap="nowrap">
              <IconButtonGhost
                size="compact-xs"
                aria-label="Previous record"
                onClick={() => stepBy(-1)}
                disabled={changedRecordCount <= 1}
              >
                <StyledLucideIcon Icon={ChevronUp} size="sm" />
              </IconButtonGhost>
              <Text12Regular c="var(--fg-muted)" style={{ whiteSpace: 'nowrap' }}>
                {currentIndex + 1} / {changedRecordCount}
              </Text12Regular>
              <IconButtonGhost
                size="compact-xs"
                aria-label="Next record"
                onClick={() => stepBy(1)}
                disabled={changedRecordCount <= 1}
              >
                <StyledLucideIcon Icon={ChevronDown} size="sm" />
              </IconButtonGhost>
              <IconButtonGhost size="compact-xs" aria-label="Close" onClick={onClose}>
                <StyledLucideIcon Icon={X} size="md" />
              </IconButtonGhost>
            </Group>
          </Group>

          {/* Title block */}
          <Box style={{ padding: '12px 16px', borderBottom: '0.5px solid var(--fg-divider)' }}>
            <TextTitle2 lineClamp={1}>{recordName}</TextTitle2>
            <Group gap={8} align="center" wrap="nowrap" mt={6}>
              <Box
                style={{
                  padding: '2px 7px',
                  borderRadius: 3,
                  backgroundColor: badge.backgroundColor,
                  flexShrink: 0,
                }}
              >
                <TextMono9Regular c={badge.foregroundColor} style={{ letterSpacing: '0.06em' }}>
                  {badge.label}
                </TextMono9Regular>
              </Box>
              <Text12Regular c="var(--fg-muted)">
                record {currentIndex + 1} of {changedRecordCount}
              </Text12Regular>
              {sessionMarker === 'approved' && (
                <Text12Regular c="var(--create-needs-review-stroke)">· ✓ approved</Text12Regular>
              )}
              {sessionMarker === 'rejected' && (
                <Text12Regular c="var(--delete-needs-review-stroke)">· ✕ rejected</Text12Regular>
              )}
            </Group>
          </Box>

          {/* Body */}
          <ScrollArea style={{ flex: 1 }}>
            {loading ? (
              <Box style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 0' }}>
                <Loader size="sm" />
              </Box>
            ) : (
              <Box style={{ padding: '4px 16px 16px' }}>{bodyContent}</Box>
            )}
          </ScrollArea>

          {/* Footer */}
          <Group
            justify="space-between"
            align="center"
            wrap="nowrap"
            style={{ padding: '12px 16px', borderTop: '0.5px solid var(--fg-divider)' }}
          >
            <FieldModeToggle mode={fieldMode} onChange={setFieldMode} />
            <Group gap={8} align="center" wrap="nowrap">
              {hasRecordLevelReview && (
                <>
                  <ButtonSecondaryGhost
                    size="compact-sm"
                    c="red.8"
                    onClick={() => runRecordAction('reject')}
                    disabled={busy || !currentFilename}
                  >
                    {rejectButtonLabel}
                  </ButtonSecondaryGhost>
                  <ButtonPrimarySolid
                    size="compact-sm"
                    onClick={() => runRecordAction('approve')}
                    disabled={busy || !currentFilename}
                  >
                    {approveButtonLabel}
                  </ButtonPrimarySolid>
                </>
              )}
            </Group>
          </Group>
        </Box>
      </Box>
    </Portal>
  );
});
