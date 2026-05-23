import { Box, Divider, Group, Loader, Menu, ScrollArea, Stack, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  Braces,
  Check,
  ChevronDown,
  ChevronUp,
  EllipsisVertical,
  FilePlus,
  Minus,
  Plus,
  RotateCcw,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { coerceCellInputTextWithSchema } from '../../../../shared/cell-value-coercion';
import { getByPath } from '../../../../shared/schema-columns';
import type { ValidationEntry, ValidationResultRow } from '../../../../shared/validation-types';
import { ButtonSecondaryGhost, ButtonSecondaryOutline, IconButtonGhost } from '../../components/base/buttons';
import { Text12Regular, TextTitle2 } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { RecordRawJsonFileEditorModal } from '../../components/RecordRawJsonFileEditorModal';
import { ScratchJsonCodeMirror, type ColumnHoverCallbacks } from '../../components/ScratchJsonCodeMirror';
import { useWorkspaceUiStore } from '../../stores/workspace-ui-store';
import { RecordFieldsGrid, type RecordFieldRow } from './RecordFieldsGrid';

interface DiffRecordColumn {
  id: string;
  displayName: string;
  attributes: { readOnly: boolean; required: boolean; nested: boolean };
}

interface DiffRecordData {
  row: {
    __rowStatus:
      | 'added'
      | 'addedUnpublished'
      | 'modified'
      | 'unpublished'
      | 'deleted'
      | 'deletedUnpublished'
      | 'unchanged'
      | 'invalidJson';
    __changedFields: string[];
    __fromFields: Record<string, unknown>;
    __unpublishedFields: string[];
    __masterFields: Record<string, unknown>;
    __filename: string;
    __parseError?: string;
    __raw: Record<string, unknown>;
  };
  columns: DiffRecordColumn[];
  workingData: Record<string, unknown> | null;
  dirtyData: Record<string, unknown> | null;
  masterData: Record<string, unknown> | null;
  displayData: Record<string, unknown> | null;
}

interface RecordDetailViewProps {
  rows: Array<{ __filename: string; __raw: Record<string, unknown>; [key: string]: unknown }>;
  selectedIndex: number;
  folderPath: string;
  workspacePath: string;
  schema: Record<string, unknown> | null;
  titleColumnId: string | null;
  /**
   * Field display order, matching the grid's visible column order (including
   * the title-first move and any user column-picker choices). Fields not in
   * this list are hidden from the detail view, matching the grid.
   */
  columnOrder: string[];
  /** Map from column ID to display label. Falls back to the raw field name when missing. */
  columnLabels?: Map<string, string>;
  /** Map from column ID to description text. */
  columnDescriptions?: Map<string, string>;
  /** Set of field paths that should be treated as read-only (derived from the view). */
  readonlyFields?: Set<string>;
  /** Map from column ID to resolved property type (e.g. 'checkbox', 'number'). */
  columnTypes?: Map<string, string>;
  /**
   * Map from column ID to effective display path, accounting for selected subfields.
   * E.g. if the `title` column has subfield `raw` selected, this maps `"title"` → `"title.raw"`.
   * Falls back to the column ID itself when not present.
   */
  columnEffectivePaths?: Map<string, string>;
  /** Map from column path to banner-group name (for visual grouping in the detail view). */
  columnGroups?: Map<string, string>;
  onSelectIndex: (index: number) => void;
  onClose: () => void;
  onRecordChanged?: () => void;
  onRecordFieldChanged?: (filename: string, fieldName: string, nextValue: unknown) => void;
  onPublishFile?: (relativePath: string) => void;
  /** Incremented by the parent when external file changes are detected, triggering a reload. */
  dataRefreshKey?: number;
  /** When set, hovering JSON keys in raw view shows column add/toggle tooltips. */
  onAddColumn?: (path: string) => void;
  /** Toggle visibility of an existing column. */
  onToggleColumnVisible?: (path: string) => void;
  /** All column paths in the view (visible + hidden). */
  allColumnPaths?: Set<string>;
  /** Column paths currently visible in the grid. */
  visibleColumnPaths?: Set<string>;
}

function rowHasUnreviewedChanges(
  row:
    | {
        __rowStatus?:
          | 'added'
          | 'addedUnpublished'
          | 'modified'
          | 'unpublished'
          | 'deleted'
          | 'deletedUnpublished'
          | 'unchanged'
          | 'invalidJson';
        __changedFields?: string[];
        [key: string]: unknown;
      }
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
    const raw = (row as { __raw?: Record<string, unknown> }).__raw;
    const val = raw ? getByPath(raw, titleColumnId) : undefined;
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
    row.__rowStatus === 'addedUnpublished' ||
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
/**
 * Walks a folder schema (which may be wrapped as `{ schema: { properties: ... } }`)
 * by `.`-delimited field path and returns the `contentMediaType` declared on the leaf
 * property, if any. Returns undefined when the schema is missing, the path doesn't
 * resolve to a property, or the property has no `contentMediaType`.
 */
function getFieldContentMediaType(folderSchema: Record<string, unknown> | null, fieldPath: string): string | undefined {
  if (!folderSchema) return undefined;
  const inner = folderSchema.schema;
  let current: Record<string, unknown> | undefined =
    inner && typeof inner === 'object' && !Array.isArray(inner) ? (inner as Record<string, unknown>) : folderSchema;
  for (const part of fieldPath.split('.')) {
    const props = current?.properties;
    if (!props || typeof props !== 'object') return undefined;
    const next = (props as Record<string, unknown>)[part];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return undefined;
    current = next as Record<string, unknown>;
  }
  const cmt = current?.contentMediaType;
  return typeof cmt === 'string' ? cmt : undefined;
}

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
  schema,
  titleColumnId,
  columnOrder,
  columnLabels,
  columnDescriptions,
  readonlyFields: readonlyFieldsProp,
  columnTypes,
  onSelectIndex,
  onClose,
  onRecordChanged,
  onRecordFieldChanged,
  onPublishFile,
  dataRefreshKey,
  onAddColumn,
  onToggleColumnVisible,
  allColumnPaths,
  visibleColumnPaths,
  columnEffectivePaths,
  columnGroups,
}: RecordDetailViewProps) {
  const [viewRaw, setViewRaw] = useState(false);
  const [rawEditorOpen, setRawEditorOpen] = useState(false);
  const [recordData, setRecordData] = useState<DiffRecordData | null>(null);
  const [loading, setLoading] = useState(false);
  const [recordReloadKey, setRecordReloadKey] = useState(0);
  const [validationReloadKey, setValidationReloadKey] = useState(0);
  const [validationResults, setValidationResults] = useState<ValidationResultRow[]>([]);
  const [editingFieldName, setEditingFieldName] = useState<string | null>(null);
  const [showAllFields, setShowAllFields] = useState(false);
  const focusedFieldName = useWorkspaceUiStore((s) => s.focusedFieldName);
  const handleFocusedFieldChange = useWorkspaceUiStore((s) => s.setFocusedFieldName);
  const setActiveFilters = useWorkspaceUiStore((s) => s.setActiveFilters);
  // Held here (not in RecordFieldsGrid) so the prettify toggle survives the
  // grid's transient unmounts during loading on record navigation.
  const [prettifyActive, setPrettifyActive] = useState(false);
  const togglePrettify = useCallback(() => setPrettifyActive((v) => !v), []);

  const selectedItemRef = useRef<HTMLButtonElement | null>(null);
  const editingFieldRef = useRef<string | null>(null);
  const loadedRecordKeyRef = useRef<string | null>(null);

  const currentRow = rows[selectedIndex];
  const recordName = currentRow ? getRecordName(currentRow, titleColumnId) : '';
  const hasUnreviewedChanges = rowHasUnreviewedChanges(recordData?.row ?? currentRow);
  const unreviewedFieldCount = recordData?.row.__changedFields.length ?? 0;
  const publishableFieldCount = recordData?.row.__unpublishedFields?.length ?? 0;
  const hasPublishableChanges =
    (recordData?.row.__unpublishedFields?.length ?? 0) > 0 ||
    recordData?.row.__rowStatus === 'addedUnpublished' ||
    recordData?.row.__rowStatus === 'deletedUnpublished';
  const isDeleted = recordData?.row.__rowStatus === 'deleted' || recordData?.row.__rowStatus === 'deletedUnpublished';
  const isCreated = recordData?.row.__rowStatus === 'added' || recordData?.row.__rowStatus === 'addedUnpublished';
  const currentFilename =
    recordData?.row.__filename ?? (typeof currentRow?.__filename === 'string' ? currentRow.__filename : undefined);

  /** Working copy path on disk for the selected record (same as invalid-json list `workingFilePath`). */
  const workingRecordFilePath = useMemo(() => {
    if (!currentFilename || !folderPath) return null;
    const dir = folderPath.replace(/\/$/, '');
    return `${dir}/${currentFilename.replace(/^\//, '')}`;
  }, [folderPath, currentFilename]);

  const currentRecordCliPath = useMemo(() => {
    const filename = typeof currentRow?.__filename === 'string' ? currentRow.__filename : undefined;
    if (!filename || !folderPath.startsWith(workspacePath)) return null;
    const relativeFolderPath = folderPath.slice(workspacePath.length).replace(/^\//, '');
    return `${relativeFolderPath}/${filename}`;
  }, [currentRow, folderPath, workspacePath]);

  const displayData = recordData?.displayData ?? null;

  const rawJsonText = useMemo(() => (displayData ? JSON.stringify(displayData, null, 2) : ''), [displayData]);

  const columnHover = useMemo<ColumnHoverCallbacks | undefined>(() => {
    if (!onAddColumn || !onToggleColumnVisible || !allColumnPaths || !visibleColumnPaths) return undefined;
    return { onAddColumn, onToggleColumnVisible, allColumns: allColumnPaths, visibleColumns: visibleColumnPaths };
  }, [onAddColumn, onToggleColumnVisible, allColumnPaths, visibleColumnPaths]);

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
    const recordKey = `${workspacePath}::${folderPath}::${selectedFilename}`;
    const isSameRecordReload = loadedRecordKeyRef.current === recordKey;
    if (!isSameRecordReload) {
      setLoading(true);
    }

    window.scratchFiles
      .readDiffRecordData(folderPath, workspacePath, selectedFilename)
      .then((result) => {
        if (!cancelled) {
          setRecordData(result);
          loadedRecordKeyRef.current = recordKey;
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRecordData(null);
          loadedRecordKeyRef.current = null;
        }
      })
      .finally(() => {
        if (!cancelled && !isSameRecordReload) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedFilename, folderPath, workspacePath, recordReloadKey, dataRefreshKey]);

  useEffect(() => {
    if (!selectedFilename) {
      setValidationResults([]);
      return;
    }
    let cancelled = false;
    window.scratchFiles
      .getValidationResults(workspacePath, folderPath, selectedFilename)
      .then((results) => {
        if (!cancelled) setValidationResults(results ?? []);
      })
      .catch(() => {
        if (!cancelled) setValidationResults([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFilename, folderPath, workspacePath, recordReloadKey, validationReloadKey, dataRefreshKey]);

  // Escape key minimizes the focused field if one is open, otherwise closes the overlay.
  // Capture phase so it fires before the grid handles it.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        console.log('Escape key pressed');
        e.stopPropagation();
        if (focusedFieldName) {
          handleFocusedFieldChange(null);
          console.log('Focused field minimized');
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose, focusedFieldName, handleFocusedFieldChange]);

  // Scroll selected item into view
  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  useEffect(() => {
    editingFieldRef.current = null;
    setEditingFieldName(null);
    setRawEditorOpen(false);
  }, [selectedIndex]);

  const handlePrev = useCallback(() => {
    if (selectedIndex > 0) onSelectIndex(selectedIndex - 1);
  }, [selectedIndex, onSelectIndex]);

  const handleNext = useCallback(() => {
    if (selectedIndex < rows.length - 1) onSelectIndex(selectedIndex + 1);
  }, [selectedIndex, rows.length, onSelectIndex]);

  // Up/Down arrow keys navigate records, mirroring the Prev/Next buttons.
  // Skipped when focus is in an editable element (inputs, textareas, CodeMirror)
  // so they don't hijack cursor movement or Select dropdown navigation.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const target = e.target;
      if (target instanceof HTMLElement) {
        if (target.isContentEditable) return;
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'ArrowUp') handlePrev();
      else handleNext();
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handlePrev, handleNext]);

  const reloadRecordAndValidations = useCallback(() => {
    setRecordReloadKey((k) => k + 1);
    setValidationReloadKey((k) => k + 1);
  }, []);

  const handleAccept = useCallback(() => {
    if (!currentRecordCliPath) return;
    void window.scratchDesktop
      .acceptRecord(workspacePath, currentRecordCliPath)
      .then((result) => {
        if (result.exitCode === 0) {
          reloadRecordAndValidations();
          onRecordChanged?.();
        }
      })
      .catch((err: unknown) => {
        console.debug('acceptRecord failed', err);
      });
  }, [workspacePath, currentRecordCliPath, reloadRecordAndValidations, onRecordChanged]);

  const handleReject = useCallback(() => {
    if (!currentRecordCliPath) return;
    void window.scratchDesktop
      .rejectRecord(workspacePath, currentRecordCliPath)
      .then((result) => {
        if (result.exitCode === 0) {
          reloadRecordAndValidations();
          onRecordChanged?.();
        }
      })
      .catch((err: unknown) => {
        console.debug('rejectRecord failed', err);
      });
  }, [workspacePath, currentRecordCliPath, reloadRecordAndValidations, onRecordChanged]);

  const handleDiscard = useCallback(() => {
    if (!currentRecordCliPath) return;
    void window.scratchDesktop
      .discardRecord(workspacePath, currentRecordCliPath)
      .then((result) => {
        if (result.exitCode === 0) {
          reloadRecordAndValidations();
          onRecordChanged?.();
        }
      })
      .catch((err: unknown) => {
        console.debug('discardRecord failed', err);
      });
  }, [workspacePath, currentRecordCliPath, reloadRecordAndValidations, onRecordChanged]);

  const handleRestore = useCallback(() => {
    const filename = filenameRef.current;
    if (!filename) return;
    void window.scratchFiles
      .restoreDeletedRecord(folderPath, workspacePath, filename)
      .then(() => {
        reloadRecordAndValidations();
        onRecordChanged?.();
      })
      .catch((err: unknown) => {
        console.debug('restoreDeletedRecord failed', err);
      });
  }, [folderPath, workspacePath, reloadRecordAndValidations, onRecordChanged]);

  const handleDiscardCreate = useCallback(() => {
    const filename = filenameRef.current;
    if (!filename) return;
    void window.scratchFiles
      .discardCreatedRecord(folderPath, workspacePath, filename)
      .then(() => {
        reloadRecordAndValidations();
        onRecordChanged?.();
      })
      .catch((err: unknown) => {
        console.debug('discardCreatedRecord failed', err);
      });
  }, [folderPath, workspacePath, reloadRecordAndValidations, onRecordChanged]);

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
          setValidationReloadKey((k) => k + 1);
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
          reloadRecordAndValidations();
          onRecordChanged?.();
        })
        .catch((err: unknown) => {
          console.error('[acceptCellChange] discard unreviewed failed:', err);
        });
    },
    [clearFieldEdit, folderPath, workspacePath, reloadRecordAndValidations, onRecordChanged],
  );

  const handleUndoApprovedCellChange = useCallback(
    (fieldName: string) => {
      const filename = filenameRef.current;
      if (!filename) return;
      clearFieldEdit();
      void window.scratchFiles
        .undoApprovedCellChange(folderPath, workspacePath, filename, fieldName)
        .then(() => {
          reloadRecordAndValidations();
          onRecordChanged?.();
        })
        .catch((err: unknown) => {
          console.error('[undoApprovedCellChange] undo failed:', err);
        });
    },
    [clearFieldEdit, folderPath, workspacePath, reloadRecordAndValidations, onRecordChanged],
  );

  const handleRawFileSaved = useCallback(() => {
    reloadRecordAndValidations();
    onRecordChanged?.();
  }, [reloadRecordAndValidations, onRecordChanged]);

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

      if (nextValue === currentValue) {
        clearFieldEdit();
        return;
      }

      try {
        coerceCellInputTextWithSchema(schema, fieldName, nextValue);
      } catch (err) {
        notifications.show({
          color: 'red',
          title: 'Invalid value',
          message: err instanceof Error ? err.message : 'The value does not match the field schema.',
        });
        return;
      }

      clearFieldEdit();

      void window.scratchFiles
        .acceptCellInputText(folderPath, workspacePath, filename, fieldName, nextValue)
        .then((result) => {
          setRecordData((prev) => (prev ? applyAcceptedFieldChangeToRecord(prev, fieldName, result.value) : prev));
          setValidationReloadKey((k) => k + 1);
          onRecordFieldChanged?.(filename, fieldName, result.value);
        })
        .catch((err: unknown) => {
          console.error('[acceptCellChange] record edit failed:', err);
          notifications.show({
            color: 'red',
            title: 'Failed to save field',
            message: err instanceof Error ? err.message : 'Unknown error',
          });
        });
    },
    [clearFieldEdit, folderPath, workspacePath, onRecordFieldChanged, schema],
  );

  const validationWarnings = useMemo(() => {
    const map = new Map<string, ValidationEntry[]>();
    for (const r of validationResults) {
      const entries = map.get(r.field_path) ?? [];
      entries.push({
        level: r.level,
        message: r.message,
        description: r.description,
        fixable: r.fixable,
        validatorKind: r.validator_kind,
      });
      map.set(r.field_path, entries);
    }
    return map;
  }, [validationResults]);

  const fieldRows = useMemo<RecordFieldRow[]>(() => {
    if (!recordData || !displayData) {
      return [];
    }

    // Row-level statuses (added, deleted) are styled at the record level — don't overlay
    // per-field diff colours on top.
    const isRowLevel =
      recordData.row.__rowStatus === 'added' ||
      recordData.row.__rowStatus === 'addedUnpublished' ||
      recordData.row.__rowStatus === 'deleted' ||
      recordData.row.__rowStatus === 'deletedUnpublished' ||
      recordData.row.__rowStatus === 'invalidJson';
    const changedFields = isRowLevel ? new Set<string>() : new Set(recordData.row.__changedFields);
    const unpublishedFields = isRowLevel ? new Set<string>() : new Set(recordData.row.__unpublishedFields);
    const recordColumnIdSet = new Set(recordData.columns.map((c) => c.id));
    const readOnlyFields =
      readonlyFieldsProp ?? new Set(recordData.columns.filter((c) => c.attributes.readOnly).map((c) => c.id));
    // Show all columns from columnOrder — don't filter against recordData.columns.
    // Fields with subfields (e.g. title: {raw, rendered}) may not appear in the CLI's
    // flat column list but are still readable via getByPath on the display data.
    const visibleFields = columnOrder.filter((fieldName) => {
      const value = getByPath(displayData, fieldName);
      return recordColumnIdSet.has(fieldName) || value !== undefined;
    });
    const columnOrderSet = new Set(columnOrder);
    const hiddenFields = showAllFields
      ? recordData.columns.map((c) => c.id).filter((id) => !columnOrderSet.has(id))
      : [];
    const orderedFields = [...visibleFields, ...hiddenFields];

    return orderedFields.map((fieldName) => {
      // Use the effective path (accounting for selected subfield) for value display,
      // but keep fieldName as the column ID for diff tracking and edit operations.
      const effectivePath = columnEffectivePaths?.get(fieldName) ?? fieldName;
      const isUnreviewed = changedFields.has(fieldName) || changedFields.has(effectivePath);
      const isUnpublished = !isUnreviewed && (unpublishedFields.has(fieldName) || unpublishedFields.has(effectivePath));
      const diffKey =
        changedFields.has(effectivePath) || unpublishedFields.has(effectivePath) ? effectivePath : fieldName;
      const isReadOnly = readOnlyFields.has(fieldName);
      const isEditable = !isDeleted && !isReadOnly;
      const diffKind = isUnreviewed ? 'unreviewed' : isUnpublished ? 'unpublished' : null;
      const value = toDisplayString(getByPath(displayData, effectivePath));
      const fromValue = isUnreviewed
        ? toDisplayString(recordData.row.__fromFields[diffKey])
        : isUnpublished
          ? toDisplayString(recordData.row.__masterFields[diffKey])
          : '';

      const fieldType = columnTypes?.get(fieldName);
      const contentMediaType = getFieldContentMediaType(schema, effectivePath);

      return {
        fieldName,
        displayLabel: columnLabels?.get(fieldName) ?? fieldName,
        description: columnDescriptions?.get(fieldName),
        groupName: columnGroups?.get(fieldName),
        value,
        fromValue,
        diffKind,
        displayMode: isUnreviewed ? 'diff' : 'current',
        editing: isEditable && editingFieldName === fieldName,
        referenceValue: diffKind !== null ? fromValue : undefined,
        column: { readonly: isReadOnly, type: fieldType },
        contentMediaType,
        onClick: isEditable
          ? fieldType === 'checkbox'
            ? () => {
                const toggled = value === 'true' ? 'false' : 'true';
                editingFieldRef.current = effectivePath;
                commitFieldEdit(effectivePath, value, toggled);
              }
            : () => beginFieldEdit(fieldName)
          : undefined,
        onEditCommit: isEditable ? (nv: string) => commitFieldEdit(effectivePath, value, nv) : undefined,
        onEditCancel: isEditable ? () => cancelFieldEdit(fieldName) : undefined,
        onApprove:
          isDeleted || !isUnreviewed ? undefined : () => handleAcceptCellChange(effectivePath, value, 'approve'),
        onUndo: isDeleted
          ? undefined
          : isUnreviewed
            ? () => handleDiscardUnreviewedCellChange(effectivePath, fromValue)
            : isUnpublished
              ? () => handleUndoApprovedCellChange(effectivePath)
              : undefined,
      };
    });
  }, [
    beginFieldEdit,
    cancelFieldEdit,
    columnDescriptions,
    columnLabels,
    columnOrder,
    commitFieldEdit,
    displayData,
    editingFieldName,
    isDeleted,
    readonlyFieldsProp,
    columnTypes,
    recordData,
    showAllFields,
    columnEffectivePaths,
    columnGroups,
    handleAcceptCellChange,
    handleDiscardUnreviewedCellChange,
    handleUndoApprovedCellChange,
    schema,
  ]);

  return (
    <>
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
              {(selectedIndex + 1).toLocaleString()} of {rows.length.toLocaleString()}
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
              const isCreateReview = row.__rowStatus === 'added';
              const isCreateApproved = row.__rowStatus === 'addedUnpublished';
              const isDeletedReview = row.__rowStatus === 'deleted';
              const isDeletedApproved = row.__rowStatus === 'deletedUnpublished';
              const hasUnreviewed =
                isCreateReview ||
                isDeletedReview ||
                (Array.isArray(row.__changedFields) && row.__changedFields.length > 0);
              const hasApproved =
                isCreateApproved ||
                isDeletedApproved ||
                (Array.isArray(row.__unpublishedFields) && row.__unpublishedFields.length > 0);
              const StatusIcon =
                isCreateReview || isCreateApproved ? Plus : isDeletedReview || isDeletedApproved ? Minus : undefined;
              const isModified = !StatusIcon && (hasUnreviewed || hasApproved);
              const iconColor = isCreateReview
                ? 'var(--create-needs-review-stroke)'
                : isCreateApproved
                  ? 'var(--create-approved-stroke)'
                  : isDeletedReview
                    ? 'var(--delete-needs-review-stroke)'
                    : isDeletedApproved
                      ? 'var(--delete-approved-stroke)'
                      : hasUnreviewed
                        ? 'var(--modified-needs-review-stroke)'
                        : hasApproved
                          ? 'var(--modified-approved-stroke)'
                          : undefined;

              return (
                <Box
                  key={i}
                  component="button"
                  ref={i === selectedIndex ? selectedItemRef : undefined}
                  onClick={() => onSelectIndex(i)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    const fn = typeof row.__filename === 'string' ? row.__filename : null;
                    if (!fn) return;
                    const filePath = `${folderPath.replace(/\/$/, '')}/${fn.replace(/^\//, '')}`;
                    const isMac = window.electron?.process?.platform === 'darwin';
                    window.scratchDesktop.showNativeContextMenu(
                      [{ id: 'reveal', label: isMac ? 'Reveal in Finder' : 'Reveal in File Explorer' }],
                      (id) => {
                        if (id === 'reveal') void window.scratchDesktop.showItemInFolder(filePath);
                      },
                    );
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    width: '100%',
                    padding: '6px 12px',
                    border: 'none',
                    backgroundColor: i === selectedIndex ? 'var(--highlight-fill)' : 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span
                    style={{
                      width: 14,
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {StatusIcon && <StatusIcon size={14} color={iconColor} />}
                    {isModified && (
                      <Box
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: '50%',
                          backgroundColor: iconColor,
                        }}
                      />
                    )}
                  </span>
                  <Text12Regular
                    c={i === selectedIndex ? 'var(--fg-primary)' : 'var(--fg-secondary)'}
                    lineClamp={1}
                    style={{
                      minWidth: 0,
                      ...(row.__rowStatus === 'deleted' || row.__rowStatus === 'deletedUnpublished'
                        ? { textDecoration: 'line-through' }
                        : undefined),
                    }}
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
          {recordData?.row.__rowStatus === 'invalidJson' && (
            <Box
              style={{
                padding: '8px 12px',
                borderBottom: '0.5px solid var(--fg-divider)',
                backgroundColor: '#fff7ed',
              }}
            >
              <Group align="flex-start" gap="sm" wrap="wrap">
                <Text12Regular c="var(--mantine-color-orange-8)" style={{ whiteSpace: 'pre-wrap' }}>
                  {typeof recordData.row.__parseError === 'string' && recordData.row.__parseError.length > 0
                    ? recordData.row.__parseError
                    : 'This record file is not valid JSON on disk.'}
                </Text12Regular>
                {workingRecordFilePath && (
                  <ButtonSecondaryOutline
                    size="compact-xs"
                    style={{ flexShrink: 0 }}
                    leftSection={<Wrench size={12} />}
                    onClick={() => setRawEditorOpen(true)}
                  >
                    Fix file
                  </ButtonSecondaryOutline>
                )}
              </Group>
            </Box>
          )}
          {recordData?.row.__rowStatus !== 'invalidJson' &&
            typeof recordData?.row.__parseError === 'string' &&
            recordData.row.__parseError.length > 0 && (
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
                {!focusedFieldName && hasUnreviewedChanges && !isDeleted && !isCreated && (
                  <>
                    <UnstyledButton
                      onClick={() => {
                        setActiveFilters([{ scope: 'global', kind: 'unreviewed' }]);
                      }}
                      style={{ whiteSpace: 'nowrap' }}
                    >
                      <Text12Regular c="var(--fg-link)" style={{ textDecoration: 'underline' }}>
                        {unreviewedFieldCount} {unreviewedFieldCount === 1 ? 'field needs' : 'fields need'} review
                      </Text12Regular>
                    </UnstyledButton>
                    <ButtonSecondaryGhost
                      size="compact-xs"
                      c="green.8"
                      onClick={handleAccept}
                      disabled={!currentRecordCliPath}
                    >
                      {unreviewedFieldCount === 1 ? 'Approve' : 'Approve all'}
                    </ButtonSecondaryGhost>
                    <ButtonSecondaryGhost
                      size="compact-xs"
                      c="red.8"
                      onClick={handleReject}
                      disabled={!currentRecordCliPath}
                    >
                      {unreviewedFieldCount === 1 ? 'Reject' : 'Reject all'}
                    </ButtonSecondaryGhost>
                  </>
                )}
                {!focusedFieldName &&
                  onPublishFile &&
                  hasPublishableChanges &&
                  !hasUnreviewedChanges &&
                  !isDeleted &&
                  !isCreated && (
                    <>
                      <UnstyledButton
                        onClick={() => {
                          setActiveFilters([{ scope: 'global', kind: 'unpublished' }]);
                        }}
                        style={{ whiteSpace: 'nowrap' }}
                      >
                        <Text12Regular c="var(--fg-link)" style={{ textDecoration: 'underline' }}>
                          {publishableFieldCount} field{publishableFieldCount === 1 ? '' : 's'} approved
                        </Text12Regular>
                      </UnstyledButton>
                      <ButtonSecondaryGhost
                        size="compact-xs"
                        onClick={() => currentRecordCliPath && onPublishFile(currentRecordCliPath)}
                        disabled={!currentRecordCliPath}
                      >
                        Publish
                      </ButtonSecondaryGhost>
                    </>
                  )}
                {!focusedFieldName && (
                  <>
                    <Divider orientation="vertical" />
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
                  </>
                )}
                {!focusedFieldName && (hasUnreviewedChanges || hasPublishableChanges) && !isDeleted && !isCreated && (
                  <Menu position="bottom-end" withinPortal zIndex={10020}>
                    <Menu.Target>
                      <IconButtonGhost size="compact-xs" aria-label="More actions">
                        <StyledLucideIcon Icon={EllipsisVertical} size="sm" />
                      </IconButtonGhost>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item
                        c="red"
                        leftSection={<StyledLucideIcon Icon={Trash2} size={14} />}
                        onClick={handleDiscard}
                        disabled={!currentRecordCliPath}
                      >
                        Discard all unpublished changes
                      </Menu.Item>
                    </Menu.Dropdown>
                  </Menu>
                )}
                <IconButtonGhost onClick={onClose}>
                  <StyledLucideIcon Icon={X} size="md" />
                </IconButtonGhost>
              </Group>
            </Group>
          </Box>

          {/* Delete banner */}
          {isDeleted && recordData && (
            <>
              <Group
                gap={8}
                align="center"
                wrap="nowrap"
                style={{
                  padding: '8px 12px',
                  backgroundColor:
                    recordData.row.__rowStatus === 'deleted'
                      ? 'var(--delete-needs-review-bg)'
                      : 'var(--delete-approved-bg)',
                  color:
                    recordData.row.__rowStatus === 'deleted'
                      ? 'var(--delete-needs-review-stroke)'
                      : 'var(--delete-approved-stroke)',
                }}
              >
                <StyledLucideIcon Icon={Trash2} size="sm" c="currentColor" />
                <Text12Regular c="currentColor" style={{ flex: 1 }}>
                  {recordData.row.__rowStatus === 'deleted'
                    ? 'Record removed'
                    : 'This record will be deleted on next publish'}
                </Text12Regular>
                {!focusedFieldName && recordData.row.__rowStatus === 'deleted' && (
                  <>
                    <ButtonSecondaryGhost
                      size="compact-xs"
                      c="currentColor"
                      leftSection={<Check size={12} />}
                      onClick={handleAccept}
                      disabled={!currentRecordCliPath}
                    >
                      Approve
                    </ButtonSecondaryGhost>
                    <ButtonSecondaryGhost
                      size="compact-xs"
                      c="currentColor"
                      leftSection={<RotateCcw size={12} />}
                      onClick={handleReject}
                      disabled={!currentRecordCliPath}
                    >
                      Reject
                    </ButtonSecondaryGhost>
                  </>
                )}
                {!focusedFieldName && recordData.row.__rowStatus === 'deletedUnpublished' && (
                  <ButtonSecondaryGhost
                    size="compact-xs"
                    c="currentColor"
                    leftSection={<RotateCcw size={12} />}
                    onClick={handleRestore}
                  >
                    Restore
                  </ButtonSecondaryGhost>
                )}
              </Group>{' '}
              <Divider />
            </>
          )}

          {/* Create banner */}
          {isCreated && recordData && (
            <>
              <Group
                gap={8}
                align="center"
                wrap="nowrap"
                style={{
                  padding: '8px 12px',
                  backgroundColor:
                    recordData.row.__rowStatus === 'added'
                      ? 'var(--create-needs-review-bg)'
                      : 'var(--create-approved-bg)',
                  color:
                    recordData.row.__rowStatus === 'added'
                      ? 'var(--create-needs-review-stroke)'
                      : 'var(--create-approved-stroke)',
                }}
              >
                <StyledLucideIcon Icon={FilePlus} size="sm" c="currentColor" />
                <Text12Regular c="currentColor" style={{ flex: 1 }}>
                  {recordData.row.__rowStatus === 'added'
                    ? 'Record added'
                    : 'This record will be created on next publish'}
                </Text12Regular>
                {!focusedFieldName && recordData.row.__rowStatus === 'added' && (
                  <>
                    <ButtonSecondaryGhost
                      size="compact-xs"
                      c="currentColor"
                      leftSection={<Check size={12} />}
                      onClick={handleAccept}
                      disabled={!currentRecordCliPath}
                    >
                      Approve
                    </ButtonSecondaryGhost>
                    <ButtonSecondaryGhost
                      size="compact-xs"
                      c="currentColor"
                      leftSection={<RotateCcw size={12} />}
                      onClick={handleReject}
                      disabled={!currentRecordCliPath}
                    >
                      Reject
                    </ButtonSecondaryGhost>
                  </>
                )}
                {!focusedFieldName && recordData.row.__rowStatus === 'addedUnpublished' && (
                  <ButtonSecondaryGhost
                    size="compact-xs"
                    c="currentColor"
                    leftSection={<Trash2 size={12} />}
                    onClick={handleDiscardCreate}
                  >
                    Discard
                  </ButtonSecondaryGhost>
                )}
              </Group>
              <Divider />
            </>
          )}

          {/* Content */}
          {loading && (
            <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Loader size="sm" />
            </Box>
          )}

          {!loading &&
            displayData &&
            !viewRaw &&
            (() => {
              const totalRecordFields = recordData?.columns.length ?? 0;
              const columnIdSet = new Set(recordData?.columns.map((c) => c.id));
              const visibleCount = columnOrder.filter((f) => columnIdSet.has(f)).length;
              const hiddenCount = totalRecordFields - visibleCount;
              return (
                <Box
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    minHeight: 0,
                  }}
                >
                  <RecordFieldsGrid
                    rows={fieldRows}
                    validationWarnings={validationWarnings}
                    initialFocusedFieldName={focusedFieldName ?? undefined}
                    onFocusedFieldChange={handleFocusedFieldChange}
                    prettifyActive={prettifyActive}
                    onPrettifyToggle={togglePrettify}
                    footer={
                      hiddenCount > 0 ? (
                        <Box style={{ padding: '8px 12px' }}>
                          <Text12Regular c="var(--fg-muted)">
                            {showAllFields ? (
                              <>
                                Showing all fields{' \u2022 '}
                                <UnstyledButton
                                  component="span"
                                  onClick={() => setShowAllFields(false)}
                                  style={{
                                    textDecoration: 'underline',
                                    color: 'var(--fg-muted)',
                                    fontSize: 'inherit',
                                  }}
                                >
                                  Hide extra
                                </UnstyledButton>
                              </>
                            ) : (
                              <>
                                {hiddenCount.toLocaleString()} more {hiddenCount === 1 ? 'field' : 'fields'} hidden in
                                view
                                {' \u2022 '}
                                <UnstyledButton
                                  component="span"
                                  onClick={() => setShowAllFields(true)}
                                  style={{
                                    textDecoration: 'underline',
                                    color: 'var(--fg-muted)',
                                    fontSize: 'inherit',
                                  }}
                                >
                                  Show all
                                </UnstyledButton>
                              </>
                            )}
                          </Text12Regular>
                        </Box>
                      ) : undefined
                    }
                  />
                </Box>
              );
            })()}

          {!loading && displayData && viewRaw && (
            <Box
              style={{
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                overflow: 'hidden',
              }}
            >
              <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                <ScratchJsonCodeMirror value={rawJsonText} readOnly columnHover={columnHover} />
              </Box>
            </Box>
          )}

          {!loading && !displayData && (
            <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Text12Regular c="dimmed">No data available</Text12Regular>
            </Box>
          )}
        </Stack>
      </Box>

      <RecordRawJsonFileEditorModal
        opened={rawEditorOpen}
        onClose={() => setRawEditorOpen(false)}
        filePath={workingRecordFilePath ?? ''}
        title={currentFilename ?? 'record.json'}
        onFileSaved={handleRawFileSaved}
      />
    </>
  );
});
