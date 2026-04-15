import { Box, Group, Loader, ScrollArea, Stack } from '@mantine/core';
import { Braces, Check, ChevronDown, ChevronUp, RotateCcw, Upload, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ButtonSecondaryGhost, IconButtonGhost } from '../../components/base/buttons';
import { Text12Regular, TextMono12Regular, TextTitle2 } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { flattenObject } from '../../utils/flatten-object';
import { RecordFieldsGrid, type RecordFieldRow } from './RecordFieldsGrid';

interface DiffRecordData {
  row: Record<string, unknown> & {
    __rowStatus: 'added' | 'modified' | 'unpublished' | 'deleted' | 'deletedUnpublished' | 'unchanged' | 'invalidJson';
    __changedFields: string[];
    __fromFields: Record<string, unknown>;
    __unpublishedFields: string[];
    __masterFields: Record<string, unknown>;
    __filename: string;
    __parseError?: string;
  };
  columns: string[];
  workingData: Record<string, unknown> | null;
  dirtyData: Record<string, unknown> | null;
  masterData: Record<string, unknown> | null;
  displayData: Record<string, unknown> | null;
}

interface RecordDetailViewProps {
  rows: Array<Record<string, unknown>>;
  selectedIndex: number;
  folderPath: string;
  workspacePath: string;
  titleColumnId: string | null;
  /**
   * Field display order, matching the grid's visible column order (including
   * the title-first move and any user column-picker choices). Fields not in
   * this list are hidden from the detail view, matching the grid.
   */
  columnOrder: string[];
  onSelectIndex: (index: number) => void;
  onClose: () => void;
  onRecordChanged?: () => void;
  onRecordFieldChanged?: (filename: string, fieldName: string, nextValue: unknown) => void;
  onPublishFile?: (relativePath: string) => void;
}

function rowHasUnreviewedChanges(
  row:
    | (Record<string, unknown> & {
        __rowStatus?:
          | 'added'
          | 'modified'
          | 'unpublished'
          | 'deleted'
          | 'deletedUnpublished'
          | 'unchanged'
          | 'invalidJson';
        __changedFields?: string[];
      })
    | null
    | undefined,
): boolean {
  if (!row) return false;
  return (
    row.__rowStatus === 'added' ||
    row.__rowStatus === 'deleted' ||
    row.__rowStatus === 'invalidJson' ||
    (row.__changedFields?.length ?? 0) > 0
  );
}

function getRecordName(row: Record<string, unknown>, titleColumnId: string | null): string {
  if (titleColumnId) {
    const val = row[titleColumnId];
    if (typeof val === 'string' && val !== '') return val;
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  }
  // Fallback to filename
  const filename = row.__filename;
  if (typeof filename === 'string') return filename.replace(/\.json$/, '');
  return '';
}

function toDisplayString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function diffValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

type DiffRow = DiffRecordData['row'];

function deriveRowStatusAfterEdit(row: DiffRow): DiffRow['__rowStatus'] {
  if (
    row.__rowStatus === 'added' ||
    row.__rowStatus === 'deleted' ||
    row.__rowStatus === 'deletedUnpublished' ||
    row.__rowStatus === 'invalidJson'
  ) {
    return row.__rowStatus;
  }
  if (row.__changedFields.length > 0) {
    return 'modified';
  }
  if (row.__unpublishedFields.length > 0) {
    return 'unpublished';
  }
  return 'unchanged';
}

/**
 * Writes a `.`-delimited field path into a nested object, creating intermediate
 * plain objects as needed. Mirrors setNestedValue in src/main/local-files.ts so
 * that optimistic updates to displayData match what readDiffRecordData would
 * see on disk. Top-level fields and nested dot paths are both supported.
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const existing = cursor[key];
    if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
      const next: Record<string, unknown> = {};
      cursor[key] = next;
      cursor = next;
    } else {
      cursor = existing as Record<string, unknown>;
    }
  }
  cursor[parts[parts.length - 1]] = value;
}

function applyAcceptedFieldChangeToRecord(prev: DiffRecordData, fieldName: string, nextValue: unknown): DiffRecordData {
  const prevRow = prev.row;

  const masterValue = prevRow.__masterFields[fieldName];
  const masterHadField = Object.prototype.hasOwnProperty.call(prevRow.__masterFields, fieldName);
  const nextFromFields = { ...prevRow.__fromFields };
  delete nextFromFields[fieldName];

  const wasUnpublished = prevRow.__unpublishedFields.includes(fieldName);
  const matchesMaster = masterHadField && diffValuesEqual(nextValue, masterValue);
  const nextUnpublishedFields = wasUnpublished
    ? matchesMaster
      ? prevRow.__unpublishedFields.filter((f) => f !== fieldName)
      : prevRow.__unpublishedFields
    : matchesMaster
      ? prevRow.__unpublishedFields
      : [...prevRow.__unpublishedFields, fieldName];

  const nextRow: DiffRow = {
    ...prevRow,
    [fieldName]: nextValue,
    __changedFields: prevRow.__changedFields.filter((f) => f !== fieldName),
    __fromFields: nextFromFields,
    __unpublishedFields: nextUnpublishedFields,
  };
  nextRow.__rowStatus = deriveRowStatusAfterEdit(nextRow);

  const nextDisplayData = prev.displayData ? { ...prev.displayData } : {};
  setNestedValue(nextDisplayData, fieldName, nextValue);

  return { ...prev, row: nextRow, displayData: nextDisplayData };
}

export const RecordDetailView = memo(function RecordDetailView({
  rows,
  selectedIndex,
  folderPath,
  workspacePath,
  titleColumnId,
  columnOrder,
  onSelectIndex,
  onClose,
  onRecordChanged,
  onRecordFieldChanged,
  onPublishFile,
}: RecordDetailViewProps) {
  const [viewRaw, setViewRaw] = useState(false);
  const [recordData, setRecordData] = useState<DiffRecordData | null>(null);
  const [loading, setLoading] = useState(false);
  const [recordReloadKey, setRecordReloadKey] = useState(0);
  const [editingFieldName, setEditingFieldName] = useState<string | null>(null);
  const selectedItemRef = useRef<HTMLButtonElement | null>(null);
  const editingFieldRef = useRef<string | null>(null);

  const currentRow = rows[selectedIndex];
  const recordName = currentRow ? getRecordName(currentRow, titleColumnId) : '';
  const hasUnreviewedChanges = rowHasUnreviewedChanges(recordData?.row ?? currentRow);
  const hasPublishableChanges =
    (recordData?.row.__unpublishedFields?.length ?? 0) > 0 ||
    recordData?.row.__rowStatus === 'added' ||
    recordData?.row.__rowStatus === 'deleted' ||
    recordData?.row.__rowStatus === 'deletedUnpublished';
  const isDeleted = recordData?.row.__rowStatus === 'deleted' || recordData?.row.__rowStatus === 'deletedUnpublished';
  const currentFilename =
    recordData?.row.__filename ?? (typeof currentRow?.__filename === 'string' ? currentRow.__filename : undefined);

  const currentRecordCliPath = useMemo(() => {
    const filename = typeof currentRow?.__filename === 'string' ? currentRow.__filename : undefined;
    if (!filename || !folderPath.startsWith(workspacePath)) return null;
    const relativeFolderPath = folderPath.slice(workspacePath.length).replace(/^\//, '');
    return `${relativeFolderPath}/${filename}`;
  }, [currentRow, folderPath, workspacePath]);

  const displayData = recordData?.displayData ?? null;

  const selectedFilename = (() => {
    const row = rows[selectedIndex];
    const filename = row?.__filename;
    return typeof filename === 'string' ? filename : undefined;
  })();

  // Load shared diff data when selection changes. We depend on selectedFilename
  // (not `rows`) so that optimistic updates in the parent grid, which produce a
  // new `rows` array reference but no filename change, do not retrigger a full
  // record reload.
  useEffect(() => {
    if (!selectedFilename) {
      setRecordData(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    window.scratchFiles
      .readDiffRecordData(folderPath, workspacePath, selectedFilename)
      .then((result) => {
        if (!cancelled) {
          setRecordData(result);
        }
      })
      .catch(() => {
        if (!cancelled) setRecordData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedFilename, folderPath, workspacePath, recordReloadKey]);

  // Escape key closes overlay (capture phase so it fires before the grid handles it)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  // Scroll selected item into view
  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  useEffect(() => {
    editingFieldRef.current = null;
    setEditingFieldName(null);
  }, [selectedIndex]);

  const handlePrev = useCallback(() => {
    if (selectedIndex > 0) onSelectIndex(selectedIndex - 1);
  }, [selectedIndex, onSelectIndex]);

  const handleNext = useCallback(() => {
    if (selectedIndex < rows.length - 1) onSelectIndex(selectedIndex + 1);
  }, [selectedIndex, rows.length, onSelectIndex]);

  const handleAccept = useCallback(() => {
    if (!currentRecordCliPath) return;
    void window.scratchDesktop
      .acceptRecord(workspacePath, currentRecordCliPath)
      .then((result) => {
        if (result.exitCode === 0) onRecordChanged?.();
      })
      .catch((err: unknown) => {
        console.debug('acceptRecord failed', err);
      });
  }, [workspacePath, currentRecordCliPath, onRecordChanged]);

  const handleReject = useCallback(() => {
    if (!currentRecordCliPath) return;
    void window.scratchDesktop
      .rejectRecord(workspacePath, currentRecordCliPath)
      .then((result) => {
        if (result.exitCode === 0) onRecordChanged?.();
      })
      .catch((err: unknown) => {
        console.debug('rejectRecord failed', err);
      });
  }, [workspacePath, currentRecordCliPath, onRecordChanged]);

  const clearFieldEdit = useCallback(() => {
    editingFieldRef.current = null;
    setEditingFieldName(null);
  }, []);

  const filenameRef = useRef(currentFilename);
  filenameRef.current = currentFilename;

  const handleAcceptCellChange = useCallback(
    (fieldName: string, value: string, logLabel: string) => {
      const filename = filenameRef.current;
      if (!filename) return;
      clearFieldEdit();
      void window.scratchFiles
        .acceptCellChange(folderPath, workspacePath, filename, fieldName, value)
        .then((result) => {
          setRecordData((prev) => (prev ? applyAcceptedFieldChangeToRecord(prev, fieldName, result.value) : prev));
          onRecordFieldChanged?.(filename, fieldName, result.value);
        })
        .catch((err: unknown) => {
          console.error(`[acceptCellChange] ${logLabel} failed:`, err);
        });
    },
    [clearFieldEdit, folderPath, workspacePath, onRecordFieldChanged],
  );

  const handleDiscardUnreviewedCellChange = useCallback(
    (fieldName: string, dirtyValue: string) => {
      const filename = filenameRef.current;
      if (!filename) return;
      clearFieldEdit();
      void window.scratchFiles
        .acceptCellChange(folderPath, workspacePath, filename, fieldName, dirtyValue)
        .then(() => {
          setRecordReloadKey((k) => k + 1);
          onRecordChanged?.();
        })
        .catch((err: unknown) => {
          console.error('[acceptCellChange] discard unreviewed failed:', err);
        });
    },
    [clearFieldEdit, folderPath, workspacePath, onRecordChanged],
  );

  const handleUndoApprovedCellChange = useCallback(
    (fieldName: string) => {
      const filename = filenameRef.current;
      if (!filename) return;
      clearFieldEdit();
      void window.scratchFiles
        .undoApprovedCellChange(folderPath, workspacePath, filename, fieldName)
        .then(() => {
          setRecordReloadKey((k) => k + 1);
          onRecordChanged?.();
        })
        .catch((err: unknown) => {
          console.error('[undoApprovedCellChange] undo failed:', err);
        });
    },
    [clearFieldEdit, folderPath, workspacePath, onRecordChanged],
  );

  const beginFieldEdit = useCallback((fieldName: string) => {
    editingFieldRef.current = fieldName;
    setEditingFieldName(fieldName);
  }, []);

  const cancelFieldEdit = useCallback(
    (fieldName: string) => {
      if (editingFieldRef.current !== fieldName) {
        return;
      }
      clearFieldEdit();
    },
    [clearFieldEdit],
  );

  const commitFieldEdit = useCallback(
    (fieldName: string, currentValue: string, nextValue: string) => {
      const filename = filenameRef.current;
      if (!filename || editingFieldRef.current !== fieldName) {
        return;
      }

      clearFieldEdit();

      if (nextValue === currentValue) {
        return;
      }

      void window.scratchFiles
        .acceptCellChange(folderPath, workspacePath, filename, fieldName, nextValue)
        .then((result) => {
          setRecordData((prev) => (prev ? applyAcceptedFieldChangeToRecord(prev, fieldName, result.value) : prev));
          onRecordFieldChanged?.(filename, fieldName, result.value);
        })
        .catch((err: unknown) => {
          console.error('[acceptCellChange] record edit failed:', err);
        });
    },
    [clearFieldEdit, folderPath, workspacePath, onRecordFieldChanged],
  );

  const fieldRows = useMemo<RecordFieldRow[]>(() => {
    if (!recordData || !displayData) {
      return [];
    }

    const displayFields = flattenObject(displayData);
    const changedFields = new Set(recordData.row.__changedFields);
    const unpublishedFields = new Set(recordData.row.__unpublishedFields);
    const recordColumnSet = new Set(recordData.columns);
    const orderedFields = columnOrder.filter((fieldName) => recordColumnSet.has(fieldName));

    return orderedFields.map((fieldName) => {
      const isUnreviewed = changedFields.has(fieldName);
      const isUnpublished = unpublishedFields.has(fieldName);
      const diffKind = isUnreviewed ? 'unreviewed' : isUnpublished ? 'unpublished' : null;
      const value = toDisplayString(displayFields[fieldName]);
      const fromValue = isUnreviewed
        ? toDisplayString(recordData.row.__fromFields[fieldName])
        : isUnpublished
          ? toDisplayString(recordData.row.__masterFields[fieldName])
          : '';

      return {
        fieldName,
        value,
        fromValue,
        diffKind,
        displayMode: isUnreviewed ? 'diff' : 'current',
        editing: !isDeleted && editingFieldName === fieldName,
        referenceValue: diffKind !== null ? fromValue : undefined,
        onClick: isDeleted ? undefined : () => beginFieldEdit(fieldName),
        onEditCommit: isDeleted ? undefined : (nextValue: string) => commitFieldEdit(fieldName, value, nextValue),
        onEditCancel: isDeleted ? undefined : () => cancelFieldEdit(fieldName),
        onApprove: isDeleted || !isUnreviewed ? undefined : () => handleAcceptCellChange(fieldName, value, 'approve'),
        onUndo: isDeleted
          ? undefined
          : isUnreviewed
            ? () => handleDiscardUnreviewedCellChange(fieldName, fromValue)
            : isUnpublished
              ? () => handleUndoApprovedCellChange(fieldName)
              : undefined,
      };
    });
  }, [
    beginFieldEdit,
    cancelFieldEdit,
    columnOrder,
    commitFieldEdit,
    displayData,
    editingFieldName,
    isDeleted,
    recordData,
    handleAcceptCellChange,
    handleDiscardUnreviewedCellChange,
    handleUndoApprovedCellChange,
  ]);

  return (
    <Box
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 10,
        display: 'flex',
        backgroundColor: 'var(--bg-base)',
        border: '0.5px solid var(--fg-divider)',
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      {/* Left panel — record navigator */}
      <Box
        style={{
          width: 240,
          minWidth: 240,
          borderRight: '0.5px solid var(--fg-divider)',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'var(--bg-panel)',
        }}
      >
        <Group
          gap={4}
          align="center"
          wrap="nowrap"
          style={{ padding: '6px 12px', borderBottom: '0.5px solid var(--fg-divider)' }}
        >
          <Text12Regular c="var(--fg-muted)" style={{ flex: 1 }}>
            {selectedIndex + 1} of {rows.length}
          </Text12Regular>
          <IconButtonGhost
            size="compact-xs"
            onClick={handlePrev}
            disabled={selectedIndex === 0}
            styles={{
              root: {
                background: 'none',
                '&:disabled': { background: 'none', border: 'none' },
              },
            }}
          >
            <StyledLucideIcon
              Icon={ChevronUp}
              size="sm"
              c={selectedIndex === 0 ? 'var(--fg-divider)' : 'var(--fg-muted)'}
            />
          </IconButtonGhost>
          <IconButtonGhost
            size="compact-xs"
            onClick={handleNext}
            disabled={selectedIndex === rows.length - 1}
            styles={{
              root: {
                background: 'none',
                '&:disabled': { background: 'none', border: 'none' },
              },
            }}
          >
            <StyledLucideIcon
              Icon={ChevronDown}
              size="sm"
              c={selectedIndex === rows.length - 1 ? 'var(--fg-divider)' : 'var(--fg-muted)'}
            />
          </IconButtonGhost>
        </Group>
        <ScrollArea style={{ flex: 1 }}>
          {rows.map((row, i) => {
            const isDeletedReview = row.__rowStatus === 'deleted';
            const isDeletedApproved = row.__rowStatus === 'deletedUnpublished';
            const hasUnreviewed =
              row.__rowStatus === 'added' ||
              isDeletedReview ||
              (Array.isArray(row.__changedFields) && row.__changedFields.length > 0);
            const hasApproved =
              isDeletedApproved || (Array.isArray(row.__unpublishedFields) && row.__unpublishedFields.length > 0);
            const barColor = isDeletedReview
              ? 'var(--delete-needs-review-stroke)'
              : isDeletedApproved
                ? 'var(--delete-approved-stroke)'
                : hasUnreviewed
                  ? 'var(--needs-review-stroke)'
                  : hasApproved
                    ? 'var(--approved-stroke)'
                    : undefined;

            return (
              <Box
                key={i}
                component="button"
                ref={i === selectedIndex ? selectedItemRef : undefined}
                onClick={() => onSelectIndex(i)}
                style={{
                  display: 'block',
                  width: '100%',
                  padding: '6px 12px',
                  border: 'none',
                  borderLeft: barColor ? `3px solid ${barColor}` : '3px solid transparent',
                  backgroundColor: i === selectedIndex ? 'var(--highlight-fill)' : 'transparent',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                <Text12Regular
                  c={i === selectedIndex ? 'var(--fg-primary)' : 'var(--fg-secondary)'}
                  lineClamp={1}
                  style={
                    row.__rowStatus === 'deleted' || row.__rowStatus === 'deletedUnpublished'
                      ? { textDecoration: 'line-through' }
                      : undefined
                  }
                >
                  {getRecordName(row, titleColumnId)}
                </Text12Regular>
              </Box>
            );
          })}
        </ScrollArea>
      </Box>

      {/* Right panel — record detail */}
      <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
        {typeof recordData?.row.__parseError === 'string' && recordData.row.__parseError.length > 0 && (
          <Box
            style={{
              padding: '8px 12px',
              borderBottom: '0.5px solid var(--fg-divider)',
              backgroundColor: '#fff7ed',
            }}
          >
            <Text12Regular c="var(--mantine-color-orange-8)">{recordData.row.__parseError}</Text12Regular>
          </Box>
        )}
        {/* Header */}
        <Box style={{ padding: '8px 12px', borderBottom: '0.5px solid var(--fg-divider)' }}>
          <Group justify="space-between" align="center" wrap="nowrap">
            <TextTitle2 lineClamp={1} style={{ flex: 1, minWidth: 0 }}>
              {recordName}
            </TextTitle2>

            <Group gap={6} align="center" wrap="nowrap">
              {hasUnreviewedChanges && (
                <ButtonSecondaryGhost
                  size="compact-xs"
                  c="green.8"
                  leftSection={<Check size={12} />}
                  onClick={handleAccept}
                  disabled={!currentRecordCliPath || !hasUnreviewedChanges}
                >
                  Approve changes
                </ButtonSecondaryGhost>
              )}
              {hasUnreviewedChanges && (
                <ButtonSecondaryGhost
                  size="compact-xs"
                  c="red.8"
                  leftSection={<RotateCcw size={12} />}
                  onClick={handleReject}
                  disabled={!currentRecordCliPath || !hasUnreviewedChanges}
                >
                  Reject changes
                </ButtonSecondaryGhost>
              )}
              {onPublishFile && hasPublishableChanges && (
                <ButtonSecondaryGhost
                  size="compact-xs"
                  leftSection={<Upload size={12} />}
                  onClick={() => currentRecordCliPath && onPublishFile(currentRecordCliPath)}
                  disabled={!currentRecordCliPath || !hasPublishableChanges}
                >
                  Publish
                </ButtonSecondaryGhost>
              )}
              <IconButtonGhost
                size="compact-xs"
                onClick={() => setViewRaw((v) => !v)}
                style={
                  viewRaw
                    ? {
                        backgroundColor: 'var(--highlight-fill)',
                        outline: '1px solid var(--highlight-border)',
                      }
                    : undefined
                }
              >
                <StyledLucideIcon Icon={Braces} size="sm" c={viewRaw ? 'var(--highlight-text)' : undefined} />
              </IconButtonGhost>
              <IconButtonGhost onClick={onClose}>
                <StyledLucideIcon Icon={X} size="md" />
              </IconButtonGhost>
            </Group>
          </Group>
        </Box>

        {/* Content */}
        {loading && (
          <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Loader size="sm" />
          </Box>
        )}

        {!loading && displayData && !viewRaw && (
          <Box
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              backgroundColor: isDeleted
                ? recordData?.row.__rowStatus === 'deleted'
                  ? 'var(--delete-needs-review-bg)'
                  : 'var(--delete-approved-bg)'
                : undefined,
            }}
          >
            <RecordFieldsGrid rows={fieldRows} />
          </Box>
        )}

        {!loading && displayData && viewRaw && (
          <ScrollArea
            style={{
              flex: 1,
              backgroundColor: isDeleted
                ? recordData?.row.__rowStatus === 'deleted'
                  ? 'var(--delete-needs-review-bg)'
                  : 'var(--delete-approved-bg)'
                : undefined,
            }}
          >
            <Box style={{ padding: 12 }}>
              <TextMono12Regular component="pre" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
                {JSON.stringify(displayData, null, 2)}
              </TextMono12Regular>
            </Box>
          </ScrollArea>
        )}

        {!loading && !displayData && (
          <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Text12Regular c="dimmed">No data available</Text12Regular>
          </Box>
        )}
      </Stack>
    </Box>
  );
});
