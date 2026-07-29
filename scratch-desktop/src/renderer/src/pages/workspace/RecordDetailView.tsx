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
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import {
  coerceCellInputTextAgainstExistingValueOrSchema,
  resolveSchemaLeafHint,
} from '../../../../shared/cell-value-coercion';
import { getByPath } from '../../../../shared/schema-columns';
import type { ValidationEntry, ValidationResultRow } from '../../../../shared/validation-types';
import { ButtonSecondaryGhost, ButtonSecondaryOutline, IconButtonGhost } from '../../components/base/buttons';
import { Text12Regular, TextTitle2 } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { RecordRawJsonFileEditorModal } from '../../components/RecordRawJsonFileEditorModal';
import { ScratchJsonCodeMirror, type ColumnHoverCallbacks } from '../../components/ScratchJsonCodeMirror';
import { workspaceRelativePosixPath } from '../../lib/workspace-relative-path';
import { useWorkspaceUiStore } from '../../stores/workspace-ui-store';
import {
  applyAcceptedFieldChangeToOpenRecordData,
  getRecordName,
  rowHasUnreviewedChanges,
  toDisplayString,
  type DiffRecordData,
} from './record-diff-helpers';
import { RecordFieldsGrid, type FieldValueViewMode, type RecordFieldRow } from './RecordFieldsGrid';

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
  onRecordStructurallyChangedRefetchAll?: () => void;
  onSingleFieldAcceptedApplyOptimistically?: (filename: string, fieldName: string, nextValue: unknown) => void;
  onPublishFile?: (relativePath: string) => void;
  /** Incremented by the parent when external file changes are detected, triggering a reload. */
  workspaceLevelDataInvalidationCounter?: number;
  /** When set, hovering JSON keys in raw view shows column add/toggle tooltips. */
  onAddColumn?: (path: string) => void;
  /** Toggle visibility of an existing column. */
  onToggleColumnVisible?: (path: string) => void;
  /** All column paths in the view (visible + hidden). */
  allColumnPaths?: Set<string>;
  /** Column paths currently visible in the grid. */
  visibleColumnPaths?: Set<string>;
}

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

/**
 * Maps a click on a field's displayed value to the matching character offset in
 * that text, so the editor can seed the caret where the user clicked instead of
 * at the start. Returns null when the mapping can't be trusted — no mouse event,
 * the caret API is unavailable, or the displayed text differs from the editable
 * value (number/date formatting, diff/prettified/preview rendering) — so the
 * caller falls back to the default caret.
 */
function computeCaretOffsetWithinClickedText(event: ReactMouseEvent | undefined, editableValue: string): number | null {
  if (!event) return null;
  const clickedElement = event.currentTarget;
  if (!(clickedElement instanceof HTMLElement)) return null;
  // Only trust the mapping when the displayed text is exactly the editable value.
  if (clickedElement.textContent !== editableValue) return null;
  const caretRange = document.caretRangeFromPoint(event.clientX, event.clientY);
  if (!caretRange) return null;
  const textNodeWalker = document.createTreeWalker(clickedElement, NodeFilter.SHOW_TEXT);
  let absoluteOffset = 0;
  for (let node = textNodeWalker.nextNode(); node; node = textNodeWalker.nextNode()) {
    if (node === caretRange.startContainer) {
      return absoluteOffset + caretRange.startOffset;
    }
    absoluteOffset += node.textContent?.length ?? 0;
  }
  return null;
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
  onRecordStructurallyChangedRefetchAll,
  onSingleFieldAcceptedApplyOptimistically,
  onPublishFile,
  workspaceLevelDataInvalidationCounter,
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
  const [openRecordValidationReloadCounter, setValidationReloadKey] = useState(0);
  const [validationResults, setValidationResults] = useState<ValidationResultRow[]>([]);
  const [editingFieldName, setEditingFieldName] = useState<string | null>(null);
  // Caret offset to seed the field editor with on its next mount, so clicking a
  // value drops the cursor where the user clicked rather than at the start.
  const [editorInitialCaretOffset, setEditorInitialCaretOffset] = useState<number | null>(null);
  const [showAllFields, setShowAllFields] = useState(false);
  const focusedFieldName = useWorkspaceUiStore((s) => s.focusedFieldName);
  const handleFocusedFieldChange = useWorkspaceUiStore((s) => s.setFocusedFieldName);
  const setActiveFilters = useWorkspaceUiStore((s) => s.setActiveFilters);
  // Held here (not in RecordFieldsGrid) so the value-view mode toggle survives the
  // grid's transient unmounts during loading on record navigation.
  const [valueViewMode, setValueViewMode] = useState<FieldValueViewMode>('source');

  const selectedItemRef = useRef<HTMLButtonElement | null>(null);
  const editingFieldRef = useRef<string | null>(null);
  // Field paths with an in-flight optimistic save. A same-record refetch must not
  // clobber these with pre-write on-disk state before the write + reindex settles.
  const pendingFieldSavesRef = useRef<Set<string>>(new Set());
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
    if (!filename) return null;
    const relativeFolderPath = workspaceRelativePosixPath(workspacePath, folderPath);
    if (!relativeFolderPath) return null;
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
        if (cancelled) return;
        // Don't let a same-record refetch (e.g. an external file-watch bump) overwrite
        // an in-flight optimistic field save with pre-write disk state. Record switches
        // and first loads (!isSameRecordReload) always apply.
        if (isSameRecordReload && pendingFieldSavesRef.current.size > 0) return;
        setRecordData(result);
        loadedRecordKeyRef.current = recordKey;
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
  }, [selectedFilename, folderPath, workspacePath, recordReloadKey, workspaceLevelDataInvalidationCounter]);

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
  }, [
    selectedFilename,
    folderPath,
    workspacePath,
    recordReloadKey,
    openRecordValidationReloadCounter,
    workspaceLevelDataInvalidationCounter,
  ]);

  // Escape key minimizes the focused field if one is open, otherwise closes the overlay.
  // Capture phase so it fires before the grid handles it.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // While a field edit is active, let the FieldEditor's own Escape handler
        // cancel the edit (revert to viewing, stay in place) rather than closing
        // the overlay or exiting focus mode. editingFieldRef is a ref, so it reads
        // the live edit state here without re-subscribing the listener.
        if (editingFieldRef.current) return;
        e.stopPropagation();
        if (focusedFieldName) {
          handleFocusedFieldChange(null);
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
        // A non-zero exit comes back as a result object, not a thrown error, so
        // surface it explicitly — never silently swallow a failed accept.
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || result.stdout.trim() || 'Failed to approve record');
        }
        reloadRecordAndValidations();
        onRecordStructurallyChangedRefetchAll?.();
      })
      .catch((err: unknown) => {
        console.error('acceptRecord failed', err);
        notifications.show({
          color: 'red',
          title: 'Failed to approve record',
          message: err instanceof Error ? err.message : 'Unknown error',
        });
      });
  }, [workspacePath, currentRecordCliPath, reloadRecordAndValidations, onRecordStructurallyChangedRefetchAll]);

  const handleReject = useCallback(() => {
    if (!currentRecordCliPath) return;
    void window.scratchDesktop
      .rejectRecord(workspacePath, currentRecordCliPath)
      .then((result) => {
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || result.stdout.trim() || 'Failed to reject record');
        }
        reloadRecordAndValidations();
        onRecordStructurallyChangedRefetchAll?.();
      })
      .catch((err: unknown) => {
        console.error('rejectRecord failed', err);
        notifications.show({
          color: 'red',
          title: 'Failed to reject record',
          message: err instanceof Error ? err.message : 'Unknown error',
        });
      });
  }, [workspacePath, currentRecordCliPath, reloadRecordAndValidations, onRecordStructurallyChangedRefetchAll]);

  const handleDiscard = useCallback(() => {
    if (!currentRecordCliPath) return;
    void window.scratchDesktop
      .discardRecord(workspacePath, currentRecordCliPath)
      .then((result) => {
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.trim() || result.stdout.trim() || 'Failed to discard record');
        }
        reloadRecordAndValidations();
        onRecordStructurallyChangedRefetchAll?.();
      })
      .catch((err: unknown) => {
        console.error('discardRecord failed', err);
        notifications.show({
          color: 'red',
          title: 'Failed to discard record',
          message: err instanceof Error ? err.message : 'Unknown error',
        });
      });
  }, [workspacePath, currentRecordCliPath, reloadRecordAndValidations, onRecordStructurallyChangedRefetchAll]);

  const handleRestore = useCallback(() => {
    const filename = filenameRef.current;
    if (!filename) return;
    void window.scratchFiles
      .restoreDeletedRecord(folderPath, workspacePath, filename)
      .then(() => {
        reloadRecordAndValidations();
        onRecordStructurallyChangedRefetchAll?.();
      })
      .catch((err: unknown) => {
        console.debug('restoreDeletedRecord failed', err);
      });
  }, [folderPath, workspacePath, reloadRecordAndValidations, onRecordStructurallyChangedRefetchAll]);

  const handleDiscardCreate = useCallback(() => {
    const filename = filenameRef.current;
    if (!filename) return;
    void window.scratchFiles
      .discardCreatedRecord(folderPath, workspacePath, filename)
      .then(() => {
        reloadRecordAndValidations();
        onRecordStructurallyChangedRefetchAll?.();
      })
      .catch((err: unknown) => {
        console.debug('discardCreatedRecord failed', err);
      });
  }, [folderPath, workspacePath, reloadRecordAndValidations, onRecordStructurallyChangedRefetchAll]);

  const clearFieldEdit = useCallback(() => {
    editingFieldRef.current = null;
    setEditingFieldName(null);
  }, []);

  const filenameRef = useRef(currentFilename);
  filenameRef.current = currentFilename;

  const handleApproveFieldClick = useCallback(
    (fieldName: string, value: string, logLabel: string) => {
      const filename = filenameRef.current;
      if (!filename) return;
      clearFieldEdit();
      void window.scratchFiles
        .acceptUnreviewedFieldEdit(folderPath, workspacePath, filename, fieldName, value)
        .then((result) => {
          setRecordData((prev) =>
            prev ? applyAcceptedFieldChangeToOpenRecordData(prev, fieldName, result.value) : prev,
          );
          setValidationReloadKey((k) => k + 1);
          onSingleFieldAcceptedApplyOptimistically?.(filename, fieldName, result.value);
        })
        .catch((err: unknown) => {
          console.error(`[acceptUnreviewedFieldEdit] ${logLabel} failed:`, err);
        });
    },
    [clearFieldEdit, folderPath, workspacePath, onSingleFieldAcceptedApplyOptimistically],
  );

  const handleRejectUnreviewedFieldClick = useCallback(
    (fieldName: string) => {
      const filename = filenameRef.current;
      if (!filename) return;
      clearFieldEdit();
      void window.scratchFiles
        .revertUnreviewedFieldEditToApproved(folderPath, workspacePath, filename, fieldName)
        .then(() => {
          reloadRecordAndValidations();
          onRecordStructurallyChangedRefetchAll?.();
        })
        .catch((err: unknown) => {
          console.error('[revertUnreviewedFieldEditToApproved] reject failed:', err);
        });
    },
    [clearFieldEdit, folderPath, workspacePath, reloadRecordAndValidations, onRecordStructurallyChangedRefetchAll],
  );

  const handleUndoApprovedFieldClick = useCallback(
    (fieldName: string) => {
      const filename = filenameRef.current;
      if (!filename) return;
      clearFieldEdit();
      void window.scratchFiles
        .dropApprovedFieldAndRestoreToMain(folderPath, workspacePath, filename, fieldName)
        .then(() => {
          reloadRecordAndValidations();
          onRecordStructurallyChangedRefetchAll?.();
        })
        .catch((err: unknown) => {
          console.error('[dropApprovedFieldAndRestoreToMain] undo failed:', err);
        });
    },
    [clearFieldEdit, folderPath, workspacePath, reloadRecordAndValidations, onRecordStructurallyChangedRefetchAll],
  );

  const handleRawFileSaved = useCallback(() => {
    reloadRecordAndValidations();
    onRecordStructurallyChangedRefetchAll?.();
  }, [reloadRecordAndValidations, onRecordStructurallyChangedRefetchAll]);

  const beginFieldEdit = useCallback((fieldName: string, caretOffset?: number | null) => {
    editingFieldRef.current = fieldName;
    setEditingFieldName(fieldName);
    setEditorInitialCaretOffset(caretOffset ?? null);
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

      clearFieldEdit();

      // Apply the edit optimistically before awaiting the IPC so the field never
      // repaints its pre-edit value in the gap between edit mode closing and the
      // backend write completing (the source of the "value reverts on quick
      // click-out" report). We interpret the typed text the same way the main
      // process does — existing on-disk leaf wins, the JSON schema only hints the
      // scalar type of an empty leaf (coerceCellInputTextAgainstExistingValueOrSchema
      // / DEV-10308) — so the optimistic value matches what gets written. The
      // `.then()` reconciles with the authoritative parsed `result.value`.
      const schemaHint = resolveSchemaLeafHint(schema, fieldName);
      setRecordData((prev) => {
        if (!prev) return prev;
        const existingValueAtFieldPath = prev.displayData ? getByPath(prev.displayData, fieldName) : undefined;
        const optimisticValue = coerceCellInputTextAgainstExistingValueOrSchema(
          existingValueAtFieldPath,
          schemaHint,
          nextValue,
        );
        return applyAcceptedFieldChangeToOpenRecordData(prev, fieldName, optimisticValue);
      });

      pendingFieldSavesRef.current.add(fieldName);
      void window.scratchFiles
        .acceptFieldEditFromInputText(folderPath, workspacePath, filename, fieldName, nextValue)
        .then((result) => {
          setRecordData((prev) =>
            prev ? applyAcceptedFieldChangeToOpenRecordData(prev, fieldName, result.value) : prev,
          );
          setValidationReloadKey((k) => k + 1);
          onSingleFieldAcceptedApplyOptimistically?.(filename, fieldName, result.value);
        })
        .catch((err: unknown) => {
          console.error('[acceptUnreviewedFieldEdit] record edit failed:', err);
          notifications.show({
            color: 'red',
            title: 'Failed to save field',
            message: err instanceof Error ? err.message : 'Unknown error',
          });
          // The optimistic value never persisted — resync with authoritative disk state.
          reloadRecordAndValidations();
        })
        .finally(() => {
          pendingFieldSavesRef.current.delete(fieldName);
        });
    },
    [
      clearFieldEdit,
      folderPath,
      workspacePath,
      schema,
      reloadRecordAndValidations,
      onSingleFieldAcceptedApplyOptimistically,
    ],
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
    // per-field diff colours on top. Exception: an approved create ('addedUnpublished')
    // with edited fields should still show per-field diffs for those edits.
    const isRowLevel =
      recordData.row.__rowStatus === 'added' ||
      (recordData.row.__rowStatus === 'addedUnpublished' && recordData.row.__changedFields.length === 0) ||
      recordData.row.__rowStatus === 'deleted' ||
      recordData.row.__rowStatus === 'deletedUnpublished' ||
      recordData.row.__rowStatus === 'invalidJson';
    const changedFields = isRowLevel ? new Set<string>() : new Set(recordData.row.__changedFields);
    const unpublishedFields = isRowLevel ? new Set<string>() : new Set(recordData.row.__unpublishedFields);
    const recordColumnIdSet = new Set(recordData.columns.map((c) => c.id));
    // A write-once field is editable only while the record is new (no published
    // master); once it exists remotely it joins the read-only set. See X_SCRATCH_WRITE_ONCE.
    // The `readonlyFieldsProp` (from the grid) carries the server view's read-only
    // columns but is row-independent, so it cannot express write-once-on-existing. We
    // therefore always layer the row-aware read-only/write-once computation on top of
    // it rather than letting the prop short-circuit it.
    const isNewRecord = recordData.row.__rowStatus === 'added' || recordData.row.__rowStatus === 'addedUnpublished';
    const readOnlyFields = new Set<string>(readonlyFieldsProp ?? []);
    for (const column of recordData.columns) {
      if (column.attributes.readOnly || (column.attributes.writeOnce && !isNewRecord)) {
        readOnlyFields.add(column.id);
      }
    }
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
        editing: isEditable && editingFieldName === effectivePath,
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
            : (event?: ReactMouseEvent) =>
                beginFieldEdit(effectivePath, computeCaretOffsetWithinClickedText(event, value))
          : undefined,
        onEditCommit: isEditable ? (nv: string) => commitFieldEdit(effectivePath, value, nv) : undefined,
        onEditCancel: isEditable ? () => cancelFieldEdit(effectivePath) : undefined,
        onApprove:
          isDeleted || !isUnreviewed ? undefined : () => handleApproveFieldClick(effectivePath, value, 'approve'),
        onUndo: isDeleted
          ? undefined
          : isUnreviewed
            ? () => handleRejectUnreviewedFieldClick(effectivePath)
            : isUnpublished
              ? () => handleUndoApprovedFieldClick(effectivePath)
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
    handleApproveFieldClick,
    handleRejectUnreviewedFieldClick,
    handleUndoApprovedFieldClick,
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
                    const isMac = window.scratchDesktop.platform === 'darwin';
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
                      data-testid="record-detail-approve"
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
                      data-testid="record-detail-approve"
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
                      data-testid="record-detail-approve"
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
                    valueViewMode={valueViewMode}
                    onValueViewModeChange={setValueViewMode}
                    editorInitialCaretOffset={editorInitialCaretOffset}
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
