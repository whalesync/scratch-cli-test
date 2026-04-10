import { Box, Group, Loader, ScrollArea, Stack } from '@mantine/core';
import { Braces, ChevronDown, ChevronUp, X } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ButtonSecondaryOutline, IconButtonGhost } from '../../components/base/buttons';
import { Text12Regular, TextMono12Regular, TextTitle2 } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { flattenObject } from '../../utils/flatten-object';
import { RecordFieldsGrid, type RecordFieldRow } from './RecordFieldsGrid';

interface DiffRecordData {
  row: Record<string, unknown> & {
    __rowStatus: 'added' | 'modified' | 'unpublished' | 'deleted' | 'unchanged';
    __changedFields: string[];
    __fromFields: Record<string, unknown>;
    __unpublishedFields: string[];
    __masterFields: Record<string, unknown>;
    __filename: string;
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
  onSelectIndex: (index: number) => void;
  onClose: () => void;
  onRecordChanged?: () => void;
  onPublishFile?: (relativePath: string) => void;
}

function rowHasUnreviewedChanges(
  row:
    | (Record<string, unknown> & {
        __rowStatus?: 'added' | 'modified' | 'unpublished' | 'deleted' | 'unchanged';
        __changedFields?: string[];
      })
    | null
    | undefined,
): boolean {
  if (!row) return false;
  return row.__rowStatus === 'added' || row.__rowStatus === 'deleted' || (row.__changedFields?.length ?? 0) > 0;
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

export const RecordDetailView = memo(function RecordDetailView({
  rows,
  selectedIndex,
  folderPath,
  workspacePath,
  titleColumnId,
  onSelectIndex,
  onClose,
  onRecordChanged,
  onPublishFile,
}: RecordDetailViewProps) {
  const [viewRaw, setViewRaw] = useState(false);
  const [recordData, setRecordData] = useState<DiffRecordData | null>(null);
  const [loading, setLoading] = useState(false);
  const [recordReloadKey, setRecordReloadKey] = useState(0);
  const [editingFieldName, setEditingFieldName] = useState<string | null>(null);
  const [editingFieldValue, setEditingFieldValue] = useState('');
  const selectedItemRef = useRef<HTMLButtonElement | null>(null);
  const editingFieldRef = useRef<string | null>(null);

  const currentRow = rows[selectedIndex];
  const recordName = currentRow ? getRecordName(currentRow, titleColumnId) : '';
  const hasUnreviewedChanges = rowHasUnreviewedChanges(recordData?.row ?? currentRow);
  const hasPublishableChanges =
    (recordData?.row.__unpublishedFields?.length ?? 0) > 0 ||
    recordData?.row.__rowStatus === 'added' ||
    recordData?.row.__rowStatus === 'deleted';
  const currentFilename =
    recordData?.row.__filename ?? (typeof currentRow?.__filename === 'string' ? currentRow.__filename : undefined);

  const currentRecordCliPath = useMemo(() => {
    const filename = typeof currentRow?.__filename === 'string' ? currentRow.__filename : undefined;
    if (!filename || !folderPath.startsWith(workspacePath)) return null;
    const relativeFolderPath = folderPath.slice(workspacePath.length).replace(/^\//, '');
    return `${relativeFolderPath}/${filename}`;
  }, [currentRow, folderPath, workspacePath]);

  const displayData = recordData?.displayData ?? null;

  // Load shared diff data when selection changes
  useEffect(() => {
    const row = rows[selectedIndex];
    const filename = row?.__filename as string | undefined;
    if (!filename) {
      setRecordData(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    window.scratchFiles
      .readDiffRecordData(folderPath, workspacePath, filename)
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
  }, [selectedIndex, rows, folderPath, workspacePath, recordReloadKey]);

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
    setEditingFieldValue('');
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
    setEditingFieldValue('');
  }, []);

  const handleAcceptCellChange = useCallback(
    (fieldName: string, value: string, logLabel: string) => {
      if (!currentFilename) return;
      clearFieldEdit();
      void window.scratchFiles
        .acceptCellChange(folderPath, workspacePath, currentFilename, fieldName, value)
        .then(() => {
          setRecordReloadKey((k) => k + 1);
          onRecordChanged?.();
        })
        .catch((err: unknown) => {
          console.error(`[acceptCellChange] ${logLabel} failed:`, err);
        });
    },
    [clearFieldEdit, currentFilename, folderPath, workspacePath, onRecordChanged],
  );

  const handleUndoApprovedCellChange = useCallback(
    (fieldName: string) => {
      if (!currentFilename) return;
      clearFieldEdit();
      void window.scratchFiles
        .undoApprovedCellChange(folderPath, workspacePath, currentFilename, fieldName)
        .then(() => {
          setRecordReloadKey((k) => k + 1);
          onRecordChanged?.();
        })
        .catch((err: unknown) => {
          console.error('[undoApprovedCellChange] undo failed:', err);
        });
    },
    [clearFieldEdit, currentFilename, folderPath, workspacePath, onRecordChanged],
  );

  const beginFieldEdit = useCallback((fieldName: string, value: string) => {
    editingFieldRef.current = fieldName;
    setEditingFieldName(fieldName);
    setEditingFieldValue(value);
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
    (fieldName: string, currentValue: string) => {
      if (!currentFilename || editingFieldRef.current !== fieldName) {
        return;
      }

      const nextValue = editingFieldValue;
      clearFieldEdit();

      if (nextValue === currentValue) {
        return;
      }

      void window.scratchFiles
        .acceptCellChange(folderPath, workspacePath, currentFilename, fieldName, nextValue)
        .then(() => {
          setRecordReloadKey((k) => k + 1);
          onRecordChanged?.();
        })
        .catch((err: unknown) => {
          console.error('[acceptCellChange] record edit failed:', err);
        });
    },
    [clearFieldEdit, currentFilename, editingFieldValue, folderPath, workspacePath, onRecordChanged],
  );

  const fieldRows = useMemo<RecordFieldRow[]>(() => {
    if (!recordData || !displayData) {
      return [];
    }

    const displayFields = flattenObject(displayData);
    const changedFields = new Set(recordData.row.__changedFields);
    const unpublishedFields = new Set(recordData.row.__unpublishedFields);

    return recordData.columns.map((fieldName) => {
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
        editing: editingFieldName === fieldName,
        editValue: editingFieldName === fieldName ? editingFieldValue : undefined,
        referenceValue: diffKind !== null ? fromValue : undefined,
        onClick: () => beginFieldEdit(fieldName, value),
        onEditValueChange: (nextValue) => setEditingFieldValue(nextValue),
        onEditCommit: () => commitFieldEdit(fieldName, value),
        onEditCancel: () => cancelFieldEdit(fieldName),
        onApprove: isUnreviewed ? () => handleAcceptCellChange(fieldName, value, 'approve') : undefined,
        onUndo: isUnreviewed
          ? () => handleAcceptCellChange(fieldName, fromValue, 'undo')
          : isUnpublished
            ? () => handleUndoApprovedCellChange(fieldName)
            : undefined,
      };
    });
  }, [
    beginFieldEdit,
    cancelFieldEdit,
    commitFieldEdit,
    displayData,
    editingFieldName,
    editingFieldValue,
    recordData,
    handleAcceptCellChange,
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
          {rows.map((row, i) => (
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
                borderLeft: 'none',
                backgroundColor: i === selectedIndex ? 'var(--highlight-fill)' : 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <Text12Regular c={i === selectedIndex ? 'var(--fg-primary)' : 'var(--fg-secondary)'} lineClamp={1}>
                {getRecordName(row, titleColumnId)}
              </Text12Regular>
            </Box>
          ))}
        </ScrollArea>
      </Box>

      {/* Right panel — record detail */}
      <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
        {/* Header */}
        <Box style={{ padding: '8px 12px', borderBottom: '0.5px solid var(--fg-divider)' }}>
          <Group justify="space-between" align="center" wrap="nowrap">
            <TextTitle2 lineClamp={1} style={{ flex: 1, minWidth: 0 }}>
              {recordName}
            </TextTitle2>

            <Group gap={6} align="center" wrap="nowrap">
              <ButtonSecondaryOutline
                size="compact-xs"
                onClick={handleAccept}
                disabled={!currentRecordCliPath || !hasUnreviewedChanges}
              >
                Accept all
              </ButtonSecondaryOutline>
              <ButtonSecondaryOutline
                size="compact-xs"
                onClick={handleReject}
                disabled={!currentRecordCliPath || !hasUnreviewedChanges}
              >
                Reject all
              </ButtonSecondaryOutline>
              {onPublishFile && (
                <ButtonSecondaryOutline
                  size="compact-xs"
                  onClick={() => currentRecordCliPath && onPublishFile(currentRecordCliPath)}
                  disabled={!currentRecordCliPath || !hasPublishableChanges}
                >
                  Publish record
                </ButtonSecondaryOutline>
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

        {!loading && displayData && !viewRaw && <RecordFieldsGrid rows={fieldRows} />}

        {!loading && displayData && viewRaw && (
          <ScrollArea style={{ flex: 1 }}>
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
