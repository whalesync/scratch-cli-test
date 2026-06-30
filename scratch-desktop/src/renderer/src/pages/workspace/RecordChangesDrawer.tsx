import { Box, Group, Loader, Portal, ScrollArea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ArrowLeft, ArrowRight, ChevronDown, ChevronUp, Trash2, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { getByPath } from '../../../../shared/schema-columns';
import { ButtonPrimarySolid, ButtonSecondaryGhost, IconButtonGhost } from '../../components/base/buttons';
import {
  Text12Regular,
  Text13Regular,
  TextMono12Regular,
  TextMono9Regular,
  TextTitle2,
} from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { workspaceRelativePosixPath } from '../../lib/workspace-relative-path';
import { getRecordName, toDisplayString, type DiffRecordData, type DiffRowStatus } from './record-diff-helpers';

interface RecordChangesDrawerProps {
  folderPath: string;
  workspacePath: string;
  titleColumnId: string | null;
  /** Map from column id to display label (e.g. "title" → "Title"). */
  columnLabels?: Map<string, string>;
  /** Map from column id to subfield-aware effective path (e.g. "title" → "title.raw"). */
  columnEffectivePaths?: Map<string, string>;
  /** Ordered filenames (grid order) of the records with unapproved changes — the set the drawer steps through. */
  changedFilenames: string[];
  /** Index into `changedFilenames` of the record currently shown. */
  currentIndex: number;
  /** Step the drawer to another record in the changed set (the header ↑/↓ stepper and arrow keys). */
  onSelectIndex: (index: number) => void;
  onClose: () => void;
  /** Called after a successful approve; the parent advances to the next changed record and refreshes the grid. */
  onApproved: (filename: string) => void;
  /** Called after a successful reject; the parent advances and refreshes the grid. */
  onRejected: (filename: string) => void;
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

/**
 * A single changed field rendered under an uppercase mono label. For modified
 * records it shows the approved value struck through, an arrow, then the new
 * local value; for created records it shows only the new value.
 */
function ChangedFieldBlock({
  label,
  fromValue,
  toValue,
  kind,
}: {
  label: string;
  fromValue?: string;
  toValue: string;
  kind: 'modified' | 'created';
}): ReactNode {
  return (
    <Box style={{ borderTop: '0.5px solid var(--fg-divider)', padding: '12px 0' }}>
      <TextMono12Regular
        c="var(--fg-muted)"
        style={{ textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: 6 }}
      >
        {label}
      </TextMono12Regular>
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
    </Box>
  );
}

export const RecordChangesDrawer = memo(function RecordChangesDrawer({
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
}: RecordChangesDrawerProps) {
  const [recordData, setRecordData] = useState<DiffRecordData | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  // In-session approve/reject markers, keyed by filename. The grid refetch removes
  // an approved/rejected record from the changed set; until that lands (or if the
  // user wraps back to it) this lets the title block show the ✓/✕ marker.
  const [sessionMarkerByFilename, setSessionMarkerByFilename] = useState<Record<string, 'approved' | 'rejected'>>({});
  const loadedRecordKeyRef = useRef<string | null>(null);

  const changedRecordCount = changedFilenames.length;
  const currentFilename = changedFilenames[currentIndex] ?? null;

  // Load the current record's three-state diff. Keyed on the filename value (not the
  // changedFilenames array reference) so a grid refetch that produces a new array but
  // keeps the same current record does not trigger a redundant reload.
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
  }, [currentFilename, folderPath, workspacePath]);

  const stepBy = useCallback(
    (delta: number) => {
      if (changedRecordCount === 0) return;
      onSelectIndex((currentIndex + delta + changedRecordCount) % changedRecordCount);
    },
    [changedRecordCount, currentIndex, onSelectIndex],
  );

  // While the drawer is open: ↑/↓ cycle between changed records (wrapping), Esc closes.
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

  const modifiedFieldBlocks = useMemo<ReactNode[]>(() => {
    if (!recordData) return [];
    const displayData = recordData.displayData ?? {};
    return recordData.row.__changedFields.map((fieldPath) => (
      <ChangedFieldBlock
        key={fieldPath}
        label={labelForChangedField(fieldPath)}
        fromValue={toDisplayString(recordData.row.__fromFields[fieldPath])}
        toValue={toDisplayString(getByPath(displayData, fieldPath))}
        kind="modified"
      />
    ));
  }, [recordData, labelForChangedField]);

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
        modifiedFieldBlocks.length > 0 ? (
          <>{modifiedFieldBlocks}</>
        ) : (
          <Box style={{ padding: '12px 0' }}>
            <Text13Regular c="var(--fg-muted)">No field changes to review.</Text13Regular>
          </Box>
        );
    }
  }

  const rejectButtonLabel = isDeletedRecord ? 'Keep record' : 'Reject';
  const approveButtonLabel = changedRecordCount > 1 ? 'Approve · next →' : 'Approve';

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
            width: 640,
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
                aria-label="Previous changed record"
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
                aria-label="Next changed record"
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

          {/* Body — changed fields only */}
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
            <Text12Regular c="var(--fg-muted)">↑ ↓ to step</Text12Regular>
            <Group gap={8} align="center" wrap="nowrap">
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
            </Group>
          </Group>
        </Box>
      </Box>
    </Portal>
  );
});
