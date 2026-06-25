'use client';

import { ButtonSecondaryOutline, IconButtonGhost } from '@/app/components/base/buttons';
import { Text12Regular, Text13Medium } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { ConfirmDialog, useConfirmDialog } from '@/app/components/modals/ConfirmDialog';
import { useDataFolders } from '@/hooks/use-data-folders';
import { useFolderFileListPaginated } from '@/hooks/use-folder-file-list-paginated';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { useSyncStore } from '@/stores/sync-store';
import { DocsUrls } from '@/utils/docs-urls';
import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import {
  Accordion,
  ActionIcon,
  Alert,
  Anchor,
  Autocomplete,
  Badge,
  Box,
  Button,
  Divider,
  Flex,
  Group,
  Loader,
  NumberInput,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
  useMantineColorScheme,
  type ComboboxLikeRenderOptionInput,
  type ComboboxStringItem,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type {
  ColumnMapping,
  DataFolderId,
  PreviewFieldResult,
  SaveSyncBody,
  SyncId,
  SyncMappingV2,
  SyncTablePair,
  TransformerConfig,
  WorkbookId,
} from '@spinner/shared-types';
import {
  getMatchFieldCompatibility,
  getTransformerLabel,
  pickMappingTransformers,
  ScheduleAction,
} from '@spinner/shared-types';
import { getHumanReadableErrorMessage } from '@spinner/shared-types/api-client';
import CodeMirror from '@uiw/react-codemirror';
import {
  AlertCircle,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleCheck,
  CornerDownRight,
  Play,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AddFolderMappingModal } from './AddFolderMappingModal';
import {
  coerceUnknownToV2,
  constantDefaultForType,
  createFieldMapping,
  createFolderPair,
  findConflictingMappingIds,
  folderPairsToV2,
  groupByDestColumn,
  isMatchedBucket,
  isSimpleGroup,
  resolveStoredMapping,
  storedMappingToV2,
  v2ToFolderPairs,
  validateV2Semantics,
  type ConstantValue,
  type FieldMapping,
  type FolderPair,
} from './sync-editor-model';
import { SyncJsonReferencePanel } from './SyncJsonReferencePanel';
import { SyncToolbar } from './SyncToolbar';
import { TablePairSelector } from './TablePairSelector';
import { isTransformerConfigComplete, TransformerConfigModal } from './TransformerConfigModal';

interface SyncEditorProps {
  workbookId: WorkbookId;
  syncId: SyncId | 'new';
}

/**
 * Type-driven editor for a `kind: 'constant'` value. Dispatches on the destination
 * column's schema type: boolean → Switch, number/integer → NumberInput, else TextInput.
 */
function ConstantValueEditor({
  value,
  destType,
  onChange,
  ariaLabel,
}: {
  value: ConstantValue;
  destType: string | undefined;
  onChange: (value: ConstantValue) => void;
  ariaLabel: string;
}) {
  if (destType === 'boolean') {
    return (
      <Switch
        size="sm"
        checked={value === true}
        onChange={(e) => onChange(e.currentTarget.checked)}
        label={value === true ? 'true' : 'false'}
        aria-label={ariaLabel}
        style={{ flex: 1 }}
      />
    );
  }
  if (destType === 'number' || destType === 'integer') {
    return (
      <NumberInput
        size="xs"
        placeholder="Constant value"
        value={typeof value === 'number' ? value : ''}
        onChange={(val) => onChange(typeof val === 'number' ? val : null)}
        allowDecimal={destType !== 'integer'}
        aria-label={ariaLabel}
        style={{ flex: 1 }}
      />
    );
  }
  return (
    <TextInput
      size="xs"
      placeholder="Constant value"
      value={value === null ? '' : String(value)}
      onChange={(e) => onChange(e.currentTarget.value)}
      aria-label={ariaLabel}
      style={{ flex: 1 }}
    />
  );
}

const renderAutocompleteOption = ({ option }: ComboboxLikeRenderOptionInput<ComboboxStringItem>) => {
  const item = option as ComboboxStringItem & { type?: string; displayLabel?: string };
  return (
    <Group gap="sm" wrap="nowrap">
      <Badge size="xs" variant="light" color="blue" w={70} style={{ flexShrink: 0 }}>
        {item.type}
      </Badge>
      <Text size="sm">{item.displayLabel ? `${item.displayLabel} (${item.value})` : item.value}</Text>
    </Group>
  );
};

const LINE_HEIGHT = 18;
const MAX_COLLAPSED_LINES = 3;
const MAX_COLLAPSED_HEIGHT = LINE_HEIGHT * MAX_COLLAPSED_LINES;

const formatPreviewValue = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
};

const getTypeLabel = (value: unknown): string => {
  if (value === null) return 'NULL';
  if (value === undefined) return 'UNDEFINED';
  if (Array.isArray(value)) return 'ARRAY';
  return (typeof value).toUpperCase();
};

function PreviewValueBox({
  sourceValue,
  transformedValue,
  warning,
}: {
  sourceValue: unknown;
  transformedValue: unknown;
  warning?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const sourceRef = useRef<HTMLDivElement>(null);
  const destRef = useRef<HTMLDivElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);

  useEffect(() => {
    const sourceOverflows = (sourceRef.current?.scrollHeight ?? 0) > MAX_COLLAPSED_HEIGHT;
    const destOverflows = (destRef.current?.scrollHeight ?? 0) > MAX_COLLAPSED_HEIGHT;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM measurement requires post-render effect
    setIsOverflowing(sourceOverflows || destOverflows);
  }, [sourceValue, transformedValue]);

  return (
    <Box
      style={{
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 'var(--mantine-radius-sm)',
        background: 'var(--mantine-color-white)',
        width: '100%',
        overflow: 'hidden',
      }}
    >
      {warning && (
        <Box style={{ padding: '4px 10px', borderBottom: '1px solid var(--mantine-color-default-border)' }}>
          <Text fz={10} c="var(--mantine-color-orange-6)">
            ⚠ {warning}
          </Text>
        </Box>
      )}
      <Box
        ref={sourceRef}
        style={{
          padding: '6px 10px',
          maxHeight: expanded ? undefined : MAX_COLLAPSED_HEIGHT,
          overflow: 'hidden',
        }}
      >
        <Group justify="space-between" align="center" wrap="nowrap" gap={6}>
          <Text
            fz="xs"
            style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap', lineHeight: `${LINE_HEIGHT}px`, flex: 1 }}
          >
            {formatPreviewValue(sourceValue)}
          </Text>
          {sourceValue !== undefined && (
            <Text fz={9} c="dimmed" tt="uppercase" lh={1} style={{ flexShrink: 0 }}>
              {getTypeLabel(sourceValue)}
            </Text>
          )}
        </Group>
      </Box>
      <Divider />
      <Box
        ref={destRef}
        style={{
          padding: '6px 10px',
          maxHeight: expanded ? undefined : MAX_COLLAPSED_HEIGHT,
          overflow: 'hidden',
        }}
      >
        <Group justify="space-between" align="center" wrap="nowrap" gap={6}>
          <Group gap={6} wrap="nowrap" align="flex-start" style={{ flex: 1 }}>
            <CornerDownRight size={12} color="var(--mantine-color-dimmed)" style={{ flexShrink: 0, marginTop: 3 }} />
            <Text
              fz="xs"
              c="dimmed"
              style={{ wordBreak: 'break-all', whiteSpace: 'pre-wrap', lineHeight: `${LINE_HEIGHT}px` }}
            >
              {formatPreviewValue(transformedValue)}
            </Text>
          </Group>
          {transformedValue !== undefined && (
            <Text fz={9} c="dimmed" tt="uppercase" lh={1} style={{ flexShrink: 0 }}>
              {getTypeLabel(transformedValue)}
            </Text>
          )}
        </Group>
      </Box>
      {isOverflowing && (
        <>
          <Divider />
          <Box
            style={{ padding: '3px 10px', cursor: 'pointer', textAlign: 'center' }}
            onClick={() => setExpanded((v) => !v)}
          >
            <Group gap={4} justify="center">
              {expanded ? (
                <ChevronUp size={12} color="var(--mantine-color-dimmed)" />
              ) : (
                <ChevronDown size={12} color="var(--mantine-color-dimmed)" />
              )}
              <Text fz={10} c="dimmed">
                {expanded ? 'Show less' : 'Show more'}
              </Text>
            </Group>
          </Box>
        </>
      )}
    </Box>
  );
}

export function SyncEditor({ workbookId, syncId }: SyncEditorProps) {
  const router = useRouter();
  const { folders: allFolders, isLoading: foldersLoading, error: foldersError } = useDataFolders();
  const syncs = useSyncStore((state) => state.syncs);
  const fetchSyncs = useSyncStore((state) => state.fetchSyncs);

  const isNew = syncId === 'new';
  const existingSync = useMemo(() => syncs.find((s) => s.id === syncId), [syncs, syncId]);

  /** Folder list from SWR can be empty on first paint; avoid "missing folder" until load finishes (or errors). */
  const folderIdsResolved = !foldersLoading && foldersError === undefined;

  const [folderPairs, setFolderPairs] = useState<FolderPair[]>([]);
  const [selectedPairIndex, setSelectedPairIndex] = useState(0);
  const [syncName, setSyncName] = useState('');
  const [schedule, setSchedule] = useState('');
  const [scheduleTimezone, setScheduleTimezone] = useState<string | null>(null);
  const [autoPublish, setAutoPublish] = useState(false);
  const [enableValidation, setEnableValidation] = useState(false);
  const [folderMappingModalOpen, setFolderMappingModalOpen] = useState(false);

  const [saving, setSaving] = useState(false);
  const [aiContextCopying, setAiContextCopying] = useState(false);
  const [errorBanner, setErrorBanner] = useState<{ title: string; body: string } | null>(null);
  const [schemaCache, setSchemaCache] = useState<
    Record<
      string,
      {
        path: string;
        type: string;
        displayLabel?: string;
        suggestedTransformer?: TransformerConfig;
        suggestedInTransformer?: TransformerConfig;
      }[]
    >
  >({});
  const [transformerModalOpen, setTransformerModalOpen] = useState(false);
  const [editingTransformerTarget, setEditingTransformerTarget] = useState<{
    pairIndex: number;
    mappingIndex: number;
  } | null>(null);

  // Confirmation dialog for the first ignore→apply flip of an unmatched-destination
  // policy on a sync that has already run (the destructive-safeguard, per client/CLAUDE.md).
  const { open: openConfirmDialog, dialogProps: confirmDialogProps } = useConfirmDialog();
  /** `${pairId}:${setting}` flips already confirmed this session — prompt only once each. */
  const confirmedPolicyFlips = useRef<Set<string>>(new Set());

  // Preview & row interaction state
  const [hoveredMappingIndex, setHoveredMappingIndex] = useState<number | null>(null);
  const [selectedPreviewFile, setSelectedPreviewFile] = useState<string | null>(null);
  const [previewResults, setPreviewResults] = useState<PreviewFieldResult[] | null>(null);
  const [previewRecordId, setPreviewRecordId] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [recordMatchingWarning, setRecordMatchingWarning] = useState<string | null>(null);

  // Sync one record
  const [syncingOneRecord, setSyncingOneRecord] = useState(false);

  // JSON editor mode
  type EditorMode = 'visual' | 'json';
  const [editorMode, setEditorMode] = useState<EditorMode>('visual');
  const [jsonContent, setJsonContent] = useState<string>('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const { colorScheme } = useMantineColorScheme();
  const cmExtensions = useMemo(() => [json(), EditorView.lineWrapping], []);

  // Track unsaved changes — snapshot the last-saved state
  const [lastSavedState, setLastSavedState] = useState<string>('');
  const getCurrentStateSnapshot = useCallback(() => {
    return JSON.stringify({ syncName, schedule, scheduleTimezone, folderPairs, editorMode, jsonContent, autoPublish });
  }, [syncName, schedule, scheduleTimezone, folderPairs, editorMode, jsonContent, autoPublish]);

  const hasUnsavedChanges = isNew ? true : getCurrentStateSnapshot() !== lastSavedState;

  // Derive active pair from selection
  const activePairIndex = Math.min(selectedPairIndex, folderPairs.length - 1);
  const activePair = folderPairs[activePairIndex];

  // Preview: folder file list (paginated)
  const {
    files: previewFiles,
    hasMore: hasMorePreviewFiles,
    loadMore: loadMorePreviewFiles,
  } = useFolderFileListPaginated(workbookId, (activePair?.sourceId || null) as DataFolderId | null, 200);

  const previewFileOptions = useMemo(
    () =>
      previewFiles
        .filter((f) => f.type === 'file' && f.path?.endsWith('.json') && !f.name?.startsWith('.'))
        .map((f) => ({ value: f.path, label: f.name || f.path })),
    [previewFiles],
  );

  // Fetch schema paths if not in cache
  const ensureSchemaPaths = async (folderId: string) => {
    if (!folderId || schemaCache[folderId]) return;
    try {
      const paths = await scratchApiClient.dataFolders.getSchemaPaths(folderId);
      setSchemaCache((prev) => ({ ...prev, [folderId]: paths }));
    } catch (error) {
      console.error('Error fetching schema paths:', error);
    }
  };

  const handleJsonContentChange = useCallback((value: string) => {
    setJsonContent(value);
    setJsonError(null);
  }, []);

  const handleModeChange = (newMode: string) => {
    if (newMode === editorMode) return;

    if (newMode === 'json') {
      // Visual → JSON: always succeeds. Serialize as the v2 shape.
      const mapping = folderPairsToV2(folderPairs);
      const jsonObj = mapping.tableMappings.length > 0 ? mapping : { version: 2, tableMappings: [] };
      setJsonContent(JSON.stringify(jsonObj, null, 2));
      setJsonError(null);
      setEditorMode('json');
    } else {
      // JSON → Visual: parse and accept v1 or v2 (v1 silently auto-upgrades to v2).
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonContent);
      } catch {
        setJsonError('Invalid JSON. Please fix syntax errors before switching to Visual mode.');
        return;
      }
      const result = coerceUnknownToV2(parsed);
      if (!result.ok) {
        setJsonError(result.error);
        return;
      }
      const pairs = v2ToFolderPairs(result.mapping, allFolders);
      setFolderPairs(pairs);
      setSelectedPairIndex(0);
      // Ensure schema paths for all referenced folders
      const folderIds = new Set<string>();
      result.mapping.tableMappings.forEach((tm) => {
        folderIds.add(tm.sourceDataFolderId);
        folderIds.add(tm.destinationDataFolderId);
      });
      folderIds.forEach((id) => ensureSchemaPaths(id));
      setJsonError(null);
      setEditorMode('visual');
      if (result.upgradedFromV1) {
        notifications.show({ message: 'Sync upgraded from v1 to v2 format', color: 'blue' });
      }
    }
  };

  // Initialize from existing sync
  useEffect(() => {
    if (isNew) {
      setFolderPairs([]);
      setSyncName('');
      setSchedule('');
      setScheduleTimezone(null);
      setAutoPublish(false);
      setEnableValidation(false);
      setEditorMode('visual');
      setJsonContent('');
      setJsonError(null);
      return;
    }

    if (!existingSync) return;

    setSyncName(existingSync.displayName);
    setAutoPublish(existingSync.publishAfterSync ?? false);
    setEditorMode('visual');

    // Fetch the SYNC schedule for this entity
    scratchApiClient.schedule
      .findByEntity(workbookId, ScheduleAction.SYNC, syncId)
      .then((syncSchedule) => {
        setSchedule(syncSchedule?.cronExpression ?? '');
        setScheduleTimezone(syncSchedule?.timezone ?? null);
      })
      .catch(() => {
        setSchedule('');
        setScheduleTimezone(null);
      });
    setJsonContent('');
    setJsonError(null);

    // The list/get endpoints return the raw row with both columns; prefer the v2
    // column when present, otherwise the frozen v1 `mappings`. Normalize v1 → v2 in
    // memory so the editor only ever works on the v2 shape.
    const stored = resolveStoredMapping(existingSync);
    let normalizedV2: SyncMappingV2 = { version: 2, tableMappings: [] };
    if (stored) {
      try {
        normalizedV2 = storedMappingToV2(stored);
      } catch (err) {
        console.debug('Failed to normalize sync mappings; starting from empty:', err);
      }
    }

    if (normalizedV2.tableMappings.length > 0) {
      const pairs = v2ToFolderPairs(normalizedV2, allFolders);
      setFolderPairs(pairs);
      setSelectedPairIndex(0);
      const uniqueFolderIds = new Set<string>();
      normalizedV2.tableMappings.forEach((tm) => {
        uniqueFolderIds.add(tm.sourceDataFolderId);
        uniqueFolderIds.add(tm.destinationDataFolderId);
      });
      uniqueFolderIds.forEach((id) => ensureSchemaPaths(id));
    } else if (existingSync.syncTablePairs?.length) {
      const pairs = existingSync.syncTablePairs.map((p: SyncTablePair) =>
        createFolderPair({
          sourceId: p.sourceDataFolderId,
          sourceFolderExists: allFolders.some((f) => f.id === p.sourceDataFolderId),
          destId: p.destinationDataFolderId,
          destFolderExists: allFolders.some((f) => f.id === p.destinationDataFolderId),
        }),
      );
      setFolderPairs(pairs);
    } else {
      setFolderPairs([]);
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncId, existingSync?.id, existingSync?.updatedAt]);

  // Capture saved state after initialization settles
  const initSettled = useRef(false);
  useEffect(() => {
    if (!isNew && existingSync && !initSettled.current) {
      // Delay to let schedule fetch resolve
      const timer = setTimeout(() => {
        setLastSavedState(getCurrentStateSnapshot());
        initSettled.current = true;
      }, 500);
      return () => clearTimeout(timer);
    }
  }, [isNew, existingSync, getCurrentStateSnapshot]);

  // Preview: reset when active pair changes
  useEffect(() => {
    setSelectedPreviewFile(null);
    setPreviewResults(null);
    setPreviewRecordId(null);
    setPreviewError(null);
    setRecordMatchingWarning(null);
  }, [activePair?.id]);

  // Preview: auto-select first file
  useEffect(() => {
    if (!selectedPreviewFile && previewFileOptions.length > 0) {
      setSelectedPreviewFile(previewFileOptions[0].value);
    }
    if (
      selectedPreviewFile &&
      previewFileOptions.length > 0 &&
      !previewFileOptions.some((f) => f.value === selectedPreviewFile)
    ) {
      setSelectedPreviewFile(null);
    }
  }, [previewFileOptions, selectedPreviewFile]);

  // Preview: debounced auto-run. Only matched column-copy rules have a previewable
  // source value; constants and unmatched-side rules are skipped.
  const previewMappingsFingerprint = JSON.stringify(activePair?.fieldMappings);
  const canPreview =
    !!activePair?.sourceId &&
    activePair.fieldMappings.some(
      (m) => m.kind === 'column' && isMatchedBucket(m.when) && m.sourceField && m.destField,
    ) &&
    !!selectedPreviewFile &&
    activePair.fieldMappings.every((m) => (m.transformers ?? []).every(isTransformerConfigComplete));

  useEffect(() => {
    if (!canPreview || !activePair || !selectedPreviewFile) return;
    const abortController = new AbortController();
    const capturedMappings = JSON.parse(previewMappingsFingerprint) as FieldMapping[];
    const timer = setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const columnMappings: ColumnMapping[] = capturedMappings
          .filter((m) => m.kind === 'column' && isMatchedBucket(m.when) && m.sourceField && m.destField)
          .map((m) => ({
            sourceColumnId: m.sourceField,
            destinationColumnId: m.destField,
            ...(m.transformers?.length > 0 ? { transformers: m.transformers } : {}),
          }));
        const recordMatching =
          activePair.matchingSourceField && activePair.matchingDestinationField
            ? {
                sourceColumnId: activePair.matchingSourceField,
                destinationColumnId: activePair.matchingDestinationField,
              }
            : undefined;
        const response = await scratchApiClient.sync.previewRecord(
          workbookId,
          activePair.sourceId as DataFolderId,
          activePair.destId as DataFolderId,
          selectedPreviewFile,
          columnMappings,
          recordMatching,
        );
        if (abortController.signal.aborted) return;
        setPreviewResults(response.fields);
        setPreviewRecordId(response.recordId);
        setRecordMatchingWarning(response.recordMatchingWarning ?? null);
      } catch (err) {
        if (abortController.signal.aborted) return;
        setPreviewError(getHumanReadableErrorMessage(err));
      } finally {
        if (!abortController.signal.aborted) setPreviewLoading(false);
      }
    }, 500);
    return () => {
      clearTimeout(timer);
      abortController.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    canPreview,
    previewMappingsFingerprint,
    selectedPreviewFile,
    activePair?.sourceId,
    activePair?.matchingSourceField,
    activePair?.matchingDestinationField,
    workbookId,
  ]);

  // Preview helpers
  const getPreviewForMapping = (mapping: FieldMapping): PreviewFieldResult | null =>
    previewResults?.find((r) => r.sourceField === mapping.sourceField && r.destinationField === mapping.destField) ??
    null;

  const getMatchStatus = (): 'matched' | 'error' | 'unmatched' => {
    if (previewError) return 'error';
    if (!activePair?.matchingSourceField || !activePair?.matchingDestinationField) return 'unmatched';
    if (previewRecordId) return 'matched';
    return 'unmatched';
  };

  // Compute a placeholder from the first folder pair (used when syncName is empty)
  const syncNamePlaceholder = useMemo(() => {
    const validPairs = folderPairs.filter((p) => p.sourceId && p.destId);
    if (validPairs.length > 0) {
      const firstPair = validPairs[0];
      const sourceFolder = allFolders.find((f) => f.id === firstPair.sourceId);
      const destFolder = allFolders.find((f) => f.id === firstPair.destId);
      if (sourceFolder && destFolder) {
        return `${sourceFolder.name} → ${destFolder.name}`;
      }
    }
    return '';
  }, [folderPairs, allFolders]);

  // Single source of truth for "what would persist" — also used for save validity.
  const validPairsCount = useMemo(() => folderPairsToV2(folderPairs).tableMappings.length, [folderPairs]);

  // Rules colliding on (destinationColumnId, when) within the active pair, flagged inline.
  const activePairConflictIds = useMemo(
    () => (activePair ? findConflictingMappingIds(activePair.fieldMappings) : new Set<string>()),
    [activePair],
  );

  const handleSave = async () => {
    setSaving(true);
    setErrorBanner(null);
    try {
      let mappings: SyncMappingV2;
      let upgradedFromV1 = false;

      if (editorMode === 'json') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(jsonContent);
        } catch {
          setErrorBanner({ title: 'Invalid JSON', body: 'Please fix syntax errors before saving.' });
          setSaving(false);
          return;
        }
        const result = coerceUnknownToV2(parsed);
        if (!result.ok) {
          setErrorBanner({ title: 'Invalid JSON structure', body: result.error });
          setSaving(false);
          return;
        }
        mappings = result.mapping;
        upgradedFromV1 = result.upgradedFromV1;
      } else {
        mappings = folderPairsToV2(folderPairs);
      }

      // Mirror the server's v2 refinements (column-only-matched, no constant on the
      // match key, one rule per (column, case)) so the user gets an inline message
      // instead of a raw 400/500 at save. (JSON-mode coerce already ran this check.)
      const semanticError = validateV2Semantics(mappings);
      if (semanticError) {
        setErrorBanner({ title: 'Invalid sync configuration', body: semanticError });
        setSaving(false);
        return;
      }

      const payload: SaveSyncBody = {
        displayName: syncName.trim() || syncNamePlaceholder || 'Untitled Sync',
        mappings,
        validateMappings: enableValidation,
        schedule,
        scheduleTimezone,
        ...(!isNew && { publishAfterSync: autoPublish }),
      };

      if (isNew) {
        const newSync = await scratchApiClient.sync.create(workbookId, payload);
        await fetchSyncs(workbookId);
        notifications.show({
          title: 'Sync created',
          message: `"${syncName}" has been created`,
          color: 'green',
        });
        router.push(`/workbook/${workbookId}/syncs/${newSync.id}`);
      } else {
        await scratchApiClient.sync.update(workbookId, syncId, payload);
        await fetchSyncs(workbookId);
        setLastSavedState(getCurrentStateSnapshot());
        notifications.show({
          title: 'Sync updated',
          message: 'Changes have been saved',
          color: 'green',
        });
      }
      if (upgradedFromV1) {
        notifications.show({ message: 'Sync upgraded from v1 to v2 format', color: 'blue' });
      }
    } catch (error) {
      console.debug('Error saving sync:', error);
      setErrorBanner({ title: 'Failed to save sync', body: getHumanReadableErrorMessage(error) });
      throw error; // Re-throw so callers (e.g. Save & Run) can detect failure
    } finally {
      setSaving(false);
    }
  };

  const handleSyncOneRecord = async () => {
    if (!selectedPreviewFile || !activePair?.sourceId || isNew) return;

    setSyncingOneRecord(true);
    try {
      // Auto-save if there are unsaved changes
      if (hasUnsavedChanges) {
        try {
          await handleSave();
        } catch {
          return; // Save failed — stop
        }
      }

      const response = await scratchApiClient.sync.syncOneRecord(
        workbookId,
        syncId as SyncId,
        selectedPreviewFile,
        activePair.sourceId as DataFolderId,
      );

      if (response.success) {
        const action = response.result.created ? 'Created' : response.result.updated ? 'Updated' : 'No changes to';
        notifications.show({
          title: 'Record synced',
          message: `${action} ${response.result.destinationPath ?? 'destination record'}`,
          color: 'green',
        });
      } else {
        notifications.show({
          title: 'Sync failed',
          message: response.result.error ?? 'Unknown error',
          color: 'red',
        });
      }
    } catch (error) {
      notifications.show({
        title: 'Sync failed',
        message: getHumanReadableErrorMessage(error),
        color: 'red',
      });
    } finally {
      setSyncingOneRecord(false);
    }
  };

  // Cmd+S / Ctrl+S keyboard shortcut to save
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 's' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const canSave = editorMode === 'visual' ? validPairsCount > 0 : !!jsonContent.trim();
        if (hasUnsavedChanges && canSave && !saving) {
          handleSaveRef.current();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [editorMode, validPairsCount, jsonContent, hasUnsavedChanges, saving]);

  const hasLinkedFolders = allFolders.some((f) => f.connectorAccountId);

  const handleCopyAiContext = async () => {
    setAiContextCopying(true);
    try {
      const { markdown } = await scratchApiClient.sync.getAiContext(workbookId);
      await navigator.clipboard.writeText(markdown);
      notifications.show({ message: 'Copied AI context to clipboard', color: 'green' });
    } catch {
      notifications.show({ message: 'Failed to copy AI context', color: 'red' });
    } finally {
      setAiContextCopying(false);
    }
  };

  // -- Pair Logic -- //
  // All folder-pair mutations are immutable (new pair/array/mapping objects) so the
  // derived useMemos keyed on `activePair` / `folderPairs` recompute correctly.
  const updateFolderPair = useCallback((pairIndex: number, updater: (pair: FolderPair) => FolderPair) => {
    setFolderPairs((prev) => prev.map((p, i) => (i === pairIndex ? updater(p) : p)));
  }, []);

  const updatePair = (index: number, changes: Partial<FolderPair>) => {
    updateFolderPair(index, (pair) => ({ ...pair, ...changes }));
  };

  const removePair = (index: number) => {
    const next = folderPairs.filter((_, i) => i !== index);
    setFolderPairs(next);
    if (selectedPairIndex >= index && selectedPairIndex > 0) {
      setSelectedPairIndex(selectedPairIndex - 1);
    }
  };

  const addPair = () => setFolderMappingModalOpen(true);

  const handleFolderMappingConfirm = (sourceId: string, destId: string) => {
    // Assume the folders exist until we know otherwise.
    const newPair = createFolderPair({
      sourceId,
      sourceFolderExists: true,
      destId,
      destFolderExists: true,
    });
    const newPairs = [...folderPairs, newPair];
    setFolderPairs(newPairs);
    setSelectedPairIndex(newPairs.length - 1);
    ensureSchemaPaths(sourceId);
    ensureSchemaPaths(destId);
  };

  const patchFieldMapping = (pairIndex: number, mappingIndex: number, changes: Partial<FieldMapping>) => {
    updateFolderPair(pairIndex, (pair) => ({
      ...pair,
      fieldMappings: pair.fieldMappings.map((m, i) => (i === mappingIndex ? { ...m, ...changes } : m)),
    }));
  };

  const addFieldMapping = (pairIndex: number, mapping: FieldMapping = createFieldMapping()) => {
    updateFolderPair(pairIndex, (pair) => ({ ...pair, fieldMappings: [...pair.fieldMappings, mapping] }));
  };

  const updateFieldMapping = (
    pairIndex: number,
    mappingIndex: number,
    field: 'sourceField' | 'destField',
    value: string,
  ) => {
    patchFieldMapping(pairIndex, mappingIndex, { [field]: value });
  };

  const removeFieldMapping = (pairIndex: number, mappingIndex: number) => {
    updateFolderPair(pairIndex, (pair) => {
      const fieldMappings = pair.fieldMappings.filter((_, i) => i !== mappingIndex);
      // Never leave a pair with zero rows — reseed a blank matched column row.
      return { ...pair, fieldMappings: fieldMappings.length > 0 ? fieldMappings : [createFieldMapping()] };
    });
  };

  const updateFieldMappingTransformers = (
    pairIndex: number,
    mappingIndex: number,
    transformers: TransformerConfig[],
  ) => {
    patchFieldMapping(pairIndex, mappingIndex, { transformers });
  };

  /** Switch a rule between copying a source column and writing a literal constant. */
  const setFieldMappingKind = (pairIndex: number, mappingIndex: number, kind: FieldMapping['kind']) => {
    const pair = folderPairs[pairIndex];
    const mapping = pair?.fieldMappings[mappingIndex];
    if (!mapping) return;
    if (kind === 'constant') {
      const destType = schemaCache[pair.destId]?.find((f) => f.path === mapping.destField)?.type;
      patchFieldMapping(pairIndex, mappingIndex, {
        kind: 'constant',
        constantValue: constantDefaultForType(destType),
        sourceField: '',
        transformers: [],
      });
    } else {
      patchFieldMapping(pairIndex, mappingIndex, { kind: 'column' });
    }
  };

  /** Retarget every rule grouped under one destination column (the group header edit). */
  const updateGroupDestField = (pairIndex: number, oldDest: string, newDest: string) => {
    updateFolderPair(pairIndex, (pair) => ({
      ...pair,
      fieldMappings: pair.fieldMappings.map((m) => (m.destField === oldDest ? { ...m, destField: newDest } : m)),
    }));
  };

  /** Add an unmatched-side constant rule to a destination column group. */
  const addUnmatchedRule = (pairIndex: number, destField: string) => {
    const destType = schemaCache[folderPairs[pairIndex]?.destId]?.find((f) => f.path === destField)?.type;
    addFieldMapping(
      pairIndex,
      createFieldMapping({
        destField,
        when: 'unmatched',
        kind: 'constant',
        constantValue: constantDefaultForType(destType),
      }),
    );
  };

  /**
   * Apply an unmatched-destination policy change. The first ignore→apply flip on a
   * sync that has already run opens a ConfirmDialog before committing (the destructive
   * safeguard); once confirmed for that setting it applies directly.
   */
  const handleDestinationPolicyChange = (
    pairIndex: number,
    setting: 'unmatchedWithMatchKey' | 'unmatchedWithoutMatchKey',
    value: 'ignore' | 'apply',
  ) => {
    const pair = folderPairs[pairIndex];
    if (!pair) return;
    const isFirstEnable = value === 'apply' && pair[setting] === 'ignore' && !isNew && !!existingSync?.lastSyncTime;
    const flipKey = `${pair.id}:${setting}`;
    if (isFirstEnable && !confirmedPolicyFlips.current.has(flipKey)) {
      openConfirmDialog({
        title: 'Enable unmatched-destination handling?',
        message:
          'Saving with this setting means the next sync run will apply these rules to destination records that have no source counterpart. You can review and reject these changes in publish review before they go live.',
        confirmLabel: 'Enable',
        cancelLabel: 'Keep ignore',
        variant: 'primary',
        onConfirm: () => {
          confirmedPolicyFlips.current.add(flipKey);
          updatePair(pairIndex, { [setting]: value });
        },
      });
      return;
    }
    updatePair(pairIndex, { [setting]: value });
  };

  const openTransformerModal = (pairIndex: number, mappingIndex: number) => {
    setEditingTransformerTarget({ pairIndex, mappingIndex });
    setTransformerModalOpen(true);
  };

  /**
   * Compute the appropriate transformers for a field mapping based on the source and dest fields.
   * Checks for a suggested transformer from the source schema first, then auto-converts if types differ.
   */
  const computeAutoTransformers = (pairIndex: number, sourceField: string, destField: string): TransformerConfig[] => {
    if (!sourceField || !destField) return [];

    const pair = folderPairs[pairIndex];
    const sourceInfo = (schemaCache[pair.sourceId] || []).find((f) => f.path === sourceField);
    const destInfo = (schemaCache[pair.destId] || []).find((f) => f.path === destField);

    // The source field's unpack hint (native → plain) plus the destination field's
    // pack hint (plain → native), with an auto_convert fallback on a plain type
    // mismatch. Shared with the server's create-schema plan so both pick identically.
    return pickMappingTransformers(sourceInfo, destInfo);
  };

  const handleReapplyDefaults = (scope: 'current' | 'all') => {
    const nextPairs = [...folderPairs];
    const pairsToUpdate = scope === 'current' ? [activePairIndex] : folderPairs.map((_, i) => i);

    pairsToUpdate.forEach((pairIdx) => {
      const pair = { ...nextPairs[pairIdx] };
      const newMappings = pair.fieldMappings.map((mapping) => {
        if (mapping.sourceField && mapping.destField) {
          return {
            ...mapping,
            transformers: computeAutoTransformers(pairIdx, mapping.sourceField, mapping.destField),
          };
        }
        return mapping;
      });
      nextPairs[pairIdx] = { ...pair, fieldMappings: newMappings };
    });

    setFolderPairs(nextPairs);
  };

  const getFolderName = (id: string) => allFolders.find((f) => f.id === id)?.name || 'Unknown';
  const getFolderConnectorService = (id: string) => allFolders.find((f) => f.id === id)?.connectorService;

  // Loading state
  if (!isNew && !existingSync) {
    return (
      <Box p="xl" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Text c="dimmed">Loading sync...</Text>
      </Box>
    );
  }

  return (
    <Stack h="100%" gap={0}>
      {/* Toolbar */}
      <SyncToolbar
        workbookId={workbookId}
        syncId={syncId}
        syncName={syncName}
        syncNamePlaceholder={syncNamePlaceholder}
        onSyncNameChange={setSyncName}
        schedule={schedule}
        scheduleTimezone={scheduleTimezone}
        onScheduleChange={(cron, timezone) => {
          setSchedule(cron);
          setScheduleTimezone(timezone);
        }}
        onSave={handleSave}
        saving={saving}
        hasUnsavedChanges={hasUnsavedChanges}
        canSave={editorMode === 'visual' ? validPairsCount > 0 : !!jsonContent.trim()}
        enableValidation={enableValidation}
        onEnableValidationChange={setEnableValidation}
        autoPublish={autoPublish}
        onAutoPublishChange={setAutoPublish}
        editorMode={editorMode}
        onEditorModeChange={handleModeChange}
        onReapplyDefaults={handleReapplyDefaults}
      />

      {/* Error Banner */}
      {errorBanner && (
        <Alert
          color="red"
          title={errorBanner.title}
          withCloseButton
          onClose={() => setErrorBanner(null)}
          mx="md"
          mt="md"
        >
          {errorBanner.body}
        </Alert>
      )}

      {/* Content */}
      {editorMode === 'visual' ? (
        <ScrollArea style={{ flex: 1 }}>
          <Stack p="md" gap="lg">
            {folderPairs.length > 0 && (
              <Group gap="sm">
                <TablePairSelector
                  folderPairs={folderPairs.map((p) => ({
                    id: p.id,
                    sourceId: p.sourceId,
                    destId: p.destId,
                    sourceFolderExists:
                      !folderIdsResolved || (p.sourceId ? allFolders.some((f) => f.id === p.sourceId) : true),
                    destFolderExists:
                      !folderIdsResolved || (p.destId ? allFolders.some((f) => f.id === p.destId) : true),
                    fieldMappingCount: p.fieldMappings.filter((m) => m.sourceField && m.destField).length,
                    sourceConnectorService: getFolderConnectorService(p.sourceId),
                    destConnectorService: getFolderConnectorService(p.destId),
                  }))}
                  selectedIndex={activePairIndex}
                  onSelect={setSelectedPairIndex}
                  onAddPair={addPair}
                  getFolderName={getFolderName}
                />
                <ActionIcon color="red" variant="subtle" onClick={() => removePair(activePairIndex)}>
                  <Trash2 size={14} />
                </ActionIcon>
                {activePair && (
                  <Text12Regular c="dimmed">
                    {activePair.fieldMappings.filter((m) => m.sourceField && m.destField).length} column mappings
                  </Text12Regular>
                )}
              </Group>
            )}

            {folderPairs.length === 0 ? (
              <Stack gap="md" py="xl" px="md">
                <Stack align="center" gap="sm">
                  <Text12Regular c="dimmed">No folder mappings yet</Text12Regular>
                  <ButtonSecondaryOutline leftSection={<StyledLucideIcon Icon={Plus} size="sm" />} onClick={addPair}>
                    Add folder mapping
                  </ButtonSecondaryOutline>
                </Stack>
              </Stack>
            ) : (
              <>
                {activePair && (
                  <Stack
                    key={activePair.id}
                    gap={0}
                    style={{ position: 'relative', marginLeft: -16, marginRight: -16 }}
                  >
                    {/* Preview background column — absolutely positioned so the border is perfectly straight */}
                    <Box
                      style={{
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        right: 0,
                        width: '33.333%',
                        background: 'var(--bg-panel)',
                        borderLeft: '1px solid var(--fg-divider)',
                        pointerEvents: 'none',
                        zIndex: 0,
                      }}
                    />

                    {/* Column header row */}
                    <Divider style={{ position: 'relative', zIndex: 1 }} />
                    <Box style={{ display: 'flex', width: '100%', position: 'relative', zIndex: 1 }}>
                      <Box style={{ width: '66.666%', display: 'flex', alignItems: 'center' }}>
                        <Group gap="xs" py={8} px={16} style={{ flex: 1 }}>
                          <Text12Regular c="dimmed" tt="uppercase" style={{ flex: 1 }}>
                            Source field
                          </Text12Regular>
                          <Box w={14} />
                          <Text12Regular c="dimmed" tt="uppercase" style={{ flex: 1 }}>
                            Dest field
                          </Text12Regular>
                          <Box w={58} />
                        </Group>
                      </Box>
                      <Box
                        style={{
                          width: '33.333%',
                          padding: '8px 12px',
                          display: 'flex',
                          flexDirection: 'column',
                          justifyContent: 'center',
                          gap: 6,
                        }}
                      >
                        <Group gap={8} wrap="nowrap">
                          <Text12Regular c="dimmed" tt="uppercase" style={{ whiteSpace: 'nowrap' }}>
                            Record preview
                          </Text12Regular>
                          {(() => {
                            const matchStatus = getMatchStatus();
                            return (
                              <>
                                {matchStatus === 'matched' && (
                                  <Tooltip label="Record matched">
                                    <CircleCheck size={16} color="var(--mantine-color-green-6)" />
                                  </Tooltip>
                                )}
                                {matchStatus === 'error' && (
                                  <Tooltip label={previewError || 'Preview error'}>
                                    <AlertCircle size={16} color="var(--mantine-color-red-6)" />
                                  </Tooltip>
                                )}
                                {matchStatus === 'unmatched' && (
                                  <Tooltip label="No record matching configured">
                                    <Circle size={16} color="var(--mantine-color-gray-5)" />
                                  </Tooltip>
                                )}
                              </>
                            );
                          })()}
                          {previewLoading && <Loader size={14} />}
                        </Group>
                        <Group gap={8} wrap="nowrap">
                          <Select
                            size="xs"
                            placeholder="Select file"
                            data={
                              hasMorePreviewFiles
                                ? [...previewFileOptions, { value: '__load_more__', label: 'Load more files...' }]
                                : previewFileOptions
                            }
                            value={selectedPreviewFile}
                            onChange={(value) => {
                              if (value === '__load_more__') {
                                loadMorePreviewFiles();
                                return;
                              }
                              setSelectedPreviewFile(value);
                            }}
                            searchable
                            allowDeselect={false}
                            nothingFoundMessage="No JSON files"
                            style={{ flex: 1 }}
                          />
                          {!isNew && selectedPreviewFile && activePair?.sourceId && (
                            <Tooltip label="Run sync for one record">
                              <ButtonSecondaryOutline
                                size="compact-xs"
                                onClick={handleSyncOneRecord}
                                disabled={syncingOneRecord || previewLoading || saving}
                                loading={syncingOneRecord}
                                leftSection={<StyledLucideIcon Icon={Play} size="sm" />}
                              >
                                Test Sync
                              </ButtonSecondaryOutline>
                            </Tooltip>
                          )}
                        </Group>
                      </Box>
                    </Box>
                    <Divider style={{ position: 'relative', zIndex: 1 }} />

                    {/* Field mapping rows, grouped by destination column. A plain matched
                        column copy renders as a flat source→dest row; a destination column
                        with constants or an unmatched-side rule renders as a stacked group. */}
                    {(() => {
                      const buildFieldOptions = (folderId: string) =>
                        [...(schemaCache[folderId] || [])]
                          .sort((a, b) => {
                            if (a.displayLabel && !b.displayLabel) return -1;
                            if (!a.displayLabel && b.displayLabel) return 1;
                            return 0;
                          })
                          .map((f) =>
                            typeof f === 'string'
                              ? { value: f, label: f, type: 'unknown' }
                              : { value: f.path, label: f.path, type: f.type, displayLabel: f.displayLabel },
                          );
                      const sourceOptions = buildFieldOptions(activePair.sourceId);
                      const destOptions = buildFieldOptions(activePair.destId);
                      const destTypeFor = (destField: string) =>
                        schemaCache[activePair.destId]?.find((f) => f.path === destField)?.type;
                      const policyAllowsApply =
                        activePair.unmatchedWithMatchKey === 'apply' || activePair.unmatchedWithoutMatchKey === 'apply';
                      const canRemove = activePair.fieldMappings.length > 1;
                      const groups = groupByDestColumn(activePair.fieldMappings);

                      const sourceFieldAutocomplete = (rule: { mapping: FieldMapping; index: number }) => (
                        <Autocomplete
                          placeholder="Source field"
                          style={{ flex: 1 }}
                          autoSelectOnBlur
                          clearable
                          value={rule.mapping.sourceField}
                          onChange={(val) => {
                            updateFieldMapping(activePairIndex, rule.index, 'sourceField', val);
                            updateFieldMappingTransformers(
                              activePairIndex,
                              rule.index,
                              computeAutoTransformers(activePairIndex, val, rule.mapping.destField),
                            );
                          }}
                          data={sourceOptions}
                          renderOption={renderAutocompleteOption}
                          rightSection={<Search size={14} color="var(--mantine-color-dimmed)" />}
                        />
                      );

                      const transformerButton = (rule: { mapping: FieldMapping; index: number }) => (
                        <Tooltip
                          label={
                            rule.mapping.transformers.length > 0
                              ? rule.mapping.transformers.map((t) => getTransformerLabel(t.type)).join(' → ')
                              : 'Transform'
                          }
                        >
                          <ActionIcon
                            variant="subtle"
                            color={rule.mapping.transformers.length > 0 ? 'blue' : 'gray'}
                            onClick={() => openTransformerModal(activePairIndex, rule.index)}
                          >
                            <Settings size={14} />
                          </ActionIcon>
                        </Tooltip>
                      );

                      const removeButton = (rule: { mapping: FieldMapping; index: number }) =>
                        canRemove ? (
                          <IconButtonGhost
                            color="gray"
                            aria-label={`Remove mapping for column ${rule.mapping.destField || 'new'}`}
                            onClick={() => removeFieldMapping(activePairIndex, rule.index)}
                          >
                            <StyledLucideIcon Icon={X} size="sm" />
                          </IconButtonGhost>
                        ) : null;

                      const conflictNote = (rule: { mapping: FieldMapping }) =>
                        activePairConflictIds.has(rule.mapping.id) ? (
                          <Text12Regular id={`conflict-${rule.mapping.id}`} c="var(--mantine-color-red-6)">
                            Another rule already targets “{rule.mapping.destField}” for the same case. Only one rule per
                            column per case is allowed.
                          </Text12Regular>
                        ) : null;

                      // The right-hand preview cell, shown only for matched column copies.
                      const previewCell = (rule: { mapping: FieldMapping; index: number }, isHovered: boolean) => {
                        const preview =
                          rule.mapping.kind === 'column' && isMatchedBucket(rule.mapping.when)
                            ? getPreviewForMapping(rule.mapping)
                            : null;
                        return (
                          <Box
                            style={{
                              width: '33.333%',
                              padding: '8px 12px',
                              display: 'flex',
                              alignItems: 'center',
                              background: isHovered ? 'var(--mantine-color-gray-1)' : undefined,
                            }}
                          >
                            <Box style={{ width: '100%', visibility: preview ? 'visible' : 'hidden' }}>
                              <PreviewValueBox
                                sourceValue={preview?.sourceValue}
                                transformedValue={preview?.transformedValue}
                                warning={preview?.warning}
                              />
                            </Box>
                          </Box>
                        );
                      };

                      const ruleRow = (
                        rule: { mapping: FieldMapping; index: number },
                        leftControls: ReactNode,
                        opts: { accent?: string } = {},
                      ) => {
                        const isHovered = hoveredMappingIndex === rule.index;
                        const conflicted = activePairConflictIds.has(rule.mapping.id);
                        const accent = conflicted
                          ? 'var(--mantine-color-red-6)'
                          : isHovered
                            ? 'var(--mantine-color-dark-7)'
                            : (opts.accent ?? 'transparent');
                        return (
                          <Box key={rule.mapping.id}>
                            <Box
                              style={{
                                display: 'flex',
                                width: '100%',
                                position: 'relative',
                                zIndex: 1,
                                background: isHovered ? 'var(--mantine-color-gray-0)' : undefined,
                                borderLeft: `3px solid ${accent}`,
                              }}
                              onMouseEnter={() => setHoveredMappingIndex(rule.index)}
                              onMouseLeave={() => setHoveredMappingIndex(null)}
                            >
                              <Box
                                style={{
                                  width: '66.666%',
                                  padding: '10px 16px 10px 13px',
                                  display: 'flex',
                                  alignItems: 'center',
                                }}
                              >
                                <Stack
                                  gap={4}
                                  style={{ flex: 1 }}
                                  aria-describedby={conflicted ? `conflict-${rule.mapping.id}` : undefined}
                                >
                                  {leftControls}
                                  {conflictNote(rule)}
                                </Stack>
                              </Box>
                              {previewCell(rule, isHovered)}
                            </Box>
                            <Divider />
                          </Box>
                        );
                      };

                      return groups.map((group) => {
                        // Flat row — a single matched column copy (today's look, no extra chrome).
                        if (isSimpleGroup(group) || !group.destField) {
                          const rule = group.rules[0];
                          const flatControls = (
                            <Group gap="xs" wrap="nowrap">
                              {sourceFieldAutocomplete(rule)}
                              <ArrowRight size={14} color="var(--mantine-color-dimmed)" style={{ flexShrink: 0 }} />
                              <Autocomplete
                                placeholder="Dest field"
                                style={{ flex: 1 }}
                                autoSelectOnBlur
                                clearable
                                value={rule.mapping.destField}
                                onChange={(val) => {
                                  updateFieldMapping(activePairIndex, rule.index, 'destField', val);
                                  updateFieldMappingTransformers(
                                    activePairIndex,
                                    rule.index,
                                    computeAutoTransformers(activePairIndex, rule.mapping.sourceField, val),
                                  );
                                }}
                                data={destOptions}
                                renderOption={renderAutocompleteOption}
                                rightSection={<Search size={14} color="var(--mantine-color-dimmed)" />}
                              />
                              {transformerButton(rule)}
                              {removeButton(rule)}
                            </Group>
                          );
                          return (
                            <Fragment key={`simple-${rule.mapping.id}`}>
                              {ruleRow(rule, flatControls)}
                              {policyAllowsApply && group.destField && (
                                <Box style={{ position: 'relative', zIndex: 1, padding: '4px 16px 8px 28px' }}>
                                  <Button
                                    variant="subtle"
                                    color="gray"
                                    size="compact-xs"
                                    aria-label={`Add unmatched-side rule to column ${group.destField}`}
                                    leftSection={<Plus size={14} />}
                                    onClick={() => addUnmatchedRule(activePairIndex, group.destField)}
                                  >
                                    Add unmatched rule
                                  </Button>
                                </Box>
                              )}
                            </Fragment>
                          );
                        }

                        // Stacked group — multiple rules and/or constants for one dest column.
                        const groupDest = group.destField;
                        return (
                          <Box
                            key={`dest-${groupDest}`}
                            style={{ position: 'relative', zIndex: 1, borderLeft: '3px solid var(--fg-divider)' }}
                          >
                            {/* Group header: the destination column (editable). */}
                            <Box style={{ display: 'flex', width: '100%' }}>
                              <Group gap="xs" wrap="nowrap" style={{ width: '66.666%', padding: '8px 16px 4px 13px' }}>
                                <Text12Regular c="dimmed" tt="uppercase" style={{ whiteSpace: 'nowrap' }}>
                                  Dest
                                </Text12Regular>
                                <Autocomplete
                                  placeholder="Dest field"
                                  style={{ flex: 1 }}
                                  autoSelectOnBlur
                                  value={groupDest}
                                  onChange={(val) => updateGroupDestField(activePairIndex, groupDest, val)}
                                  data={destOptions}
                                  renderOption={renderAutocompleteOption}
                                  rightSection={<Search size={14} color="var(--mantine-color-dimmed)" />}
                                />
                              </Group>
                              <Box style={{ width: '33.333%' }} />
                            </Box>

                            {group.rules.map((rule) => {
                              const isUnmatched = !isMatchedBucket(rule.mapping.when);
                              const destType = destTypeFor(rule.mapping.destField);
                              const leftControls = (
                                <Group gap="xs" wrap="nowrap" pl={isUnmatched ? 20 : 0}>
                                  {isUnmatched ? (
                                    <Text12Regular c="var(--fg-secondary)" style={{ whiteSpace: 'nowrap' }}>
                                      on unmatched:
                                    </Text12Regular>
                                  ) : (
                                    <Text12Regular c="var(--fg-secondary)" w={64} style={{ flexShrink: 0 }}>
                                      Matched
                                    </Text12Regular>
                                  )}
                                  {!isUnmatched && (
                                    <Select
                                      size="xs"
                                      w={120}
                                      aria-label="Value source"
                                      allowDeselect={false}
                                      data={[
                                        { value: 'column', label: 'Source column' },
                                        { value: 'constant', label: 'Constant' },
                                      ]}
                                      value={rule.mapping.kind}
                                      onChange={(val) =>
                                        val &&
                                        setFieldMappingKind(activePairIndex, rule.index, val as FieldMapping['kind'])
                                      }
                                      style={{ flexShrink: 0 }}
                                    />
                                  )}
                                  {!isUnmatched && rule.mapping.kind === 'column' ? (
                                    <>
                                      {sourceFieldAutocomplete(rule)}
                                      {transformerButton(rule)}
                                    </>
                                  ) : (
                                    <ConstantValueEditor
                                      value={rule.mapping.constantValue}
                                      destType={destType}
                                      ariaLabel={`Constant value for ${rule.mapping.destField} (${rule.mapping.when})`}
                                      onChange={(value) =>
                                        patchFieldMapping(activePairIndex, rule.index, { constantValue: value })
                                      }
                                    />
                                  )}
                                  {removeButton(rule)}
                                </Group>
                              );
                              return ruleRow(rule, leftControls, { accent: 'var(--fg-divider)' });
                            })}

                            {policyAllowsApply && (
                              <Box style={{ padding: '4px 16px 8px 28px' }}>
                                <Button
                                  variant="subtle"
                                  color="gray"
                                  size="compact-xs"
                                  aria-label={`Add unmatched-side rule to column ${groupDest}`}
                                  leftSection={<Plus size={14} />}
                                  onClick={() => addUnmatchedRule(activePairIndex, groupDest)}
                                >
                                  Add unmatched rule
                                </Button>
                              </Box>
                            )}
                          </Box>
                        );
                      });
                    })()}

                    {/* Footer row */}
                    <Box style={{ display: 'flex', width: '100%', position: 'relative', zIndex: 1 }}>
                      <Box style={{ width: '66.666%', padding: '8px 16px' }}>
                        <Stack gap={0}>
                          <Button
                            variant="subtle"
                            color="gray"
                            size="xs"
                            leftSection={<Plus size={14} />}
                            onClick={() => addFieldMapping(activePairIndex)}
                            style={{ alignSelf: 'flex-start' }}
                          >
                            Add column mapping
                          </Button>

                          <Box pt={16} pb={16}>
                            <Select
                              label={
                                <>
                                  Record matching{' '}
                                  <Anchor href={DocsUrls.recordMatching} target="_blank" size="xs" fw="normal">
                                    How does this work?
                                  </Anchor>
                                </>
                              }
                              description="Select a field that is unique, so we know which record to sync changes to."
                              placeholder="Select matching pair"
                              data={activePair.fieldMappings
                                .filter((m) => m.sourceField && m.destField)
                                .reduce<{ value: string; label: string; disabled?: boolean }[]>((acc, m) => {
                                  const value = `${m.sourceField}::${m.destField}`;
                                  if (acc.some((item) => item.value === value)) {
                                    return acc;
                                  }
                                  // Matching reduces each side to a canonical primitive via the field's own
                                  // extraction transformer; a field with no extractable primitive can't be a
                                  // match key. Only disable a side once we positively know it's incompatible —
                                  // an unloaded schema (missing hints) must not disable the option.
                                  const sourceHints = schemaCache[activePair.sourceId]?.find(
                                    (f) => f.path === m.sourceField,
                                  );
                                  const destHints = schemaCache[activePair.destId]?.find((f) => f.path === m.destField);
                                  const incompatible =
                                    (!!sourceHints && !getMatchFieldCompatibility(sourceHints).usable) ||
                                    (!!destHints && !getMatchFieldCompatibility(destHints).usable);
                                  acc.push({
                                    value,
                                    label: incompatible
                                      ? `${m.sourceField} <-> ${m.destField} — can't be used to match records`
                                      : `${m.sourceField} <-> ${m.destField}`,
                                    disabled: incompatible,
                                  });
                                  return acc;
                                }, [])}
                              value={
                                activePair.matchingSourceField && activePair.matchingDestinationField
                                  ? `${activePair.matchingSourceField}::${activePair.matchingDestinationField}`
                                  : null
                              }
                              error={
                                activePair.fieldMappings.every(
                                  (mapping) =>
                                    mapping.sourceField !== activePair.matchingSourceField ||
                                    mapping.destField !== activePair.matchingDestinationField,
                                ) && 'Record matching must use one of the current field mappings'
                              }
                              onChange={(val) => {
                                const [sourceField, destField] = val?.split('::') ?? [];
                                updatePair(activePairIndex, {
                                  matchingSourceField: sourceField || '',
                                  matchingDestinationField: destField || '',
                                });
                              }}
                              searchable
                              clearable
                            />
                            {recordMatchingWarning && (
                              <Alert color="orange" variant="light" icon={<AlertCircle size={16} />} mt="xs">
                                {recordMatchingWarning}
                              </Alert>
                            )}
                          </Box>

                          {/* Unmatched-record handling — advanced policies, collapsed by default. */}
                          <Accordion variant="separated" chevronPosition="left" defaultValue={null}>
                            <Accordion.Item value="unmatched-handling">
                              <Accordion.Control>
                                <Text13Medium>Unmatched record handling — advanced</Text13Medium>
                              </Accordion.Control>
                              <Accordion.Panel>
                                <Stack gap="lg">
                                  <Box>
                                    <Text13Medium mb={6}>Source records with no destination match</Text13Medium>
                                    <SegmentedControl
                                      size="xs"
                                      aria-label="Source records with no destination match"
                                      value={activePair.unmatchedSourcePolicy}
                                      onChange={(val) =>
                                        updatePair(activePairIndex, {
                                          unmatchedSourcePolicy: val as FolderPair['unmatchedSourcePolicy'],
                                        })
                                      }
                                      data={[
                                        { value: 'create', label: 'Create new destination records (default)' },
                                        { value: 'ignore', label: "Ignore — don't create new records" },
                                      ]}
                                    />
                                  </Box>

                                  <Box>
                                    <Text13Medium mb={6}>Destination records with no source match</Text13Medium>
                                    <Stack gap="sm">
                                      <Box>
                                        <Text12Regular mb={4}>Synced records that lost their source</Text12Regular>
                                        <SegmentedControl
                                          size="xs"
                                          aria-label="Synced records that lost their source"
                                          value={activePair.unmatchedWithMatchKey}
                                          onChange={(val) =>
                                            handleDestinationPolicyChange(
                                              activePairIndex,
                                              'unmatchedWithMatchKey',
                                              val as 'ignore' | 'apply',
                                            )
                                          }
                                          data={[
                                            { value: 'apply', label: 'Apply' },
                                            { value: 'ignore', label: 'Ignore' },
                                          ]}
                                        />
                                        <Text12Regular c="var(--fg-secondary)" fs="italic" mt={4}>
                                          Records previously created by this sync whose source has been deleted.
                                          Typically: yes, archive them.
                                        </Text12Regular>
                                      </Box>
                                      <Box>
                                        <Text12Regular mb={4}>Hand-authored or pre-existing records</Text12Regular>
                                        <SegmentedControl
                                          size="xs"
                                          aria-label="Hand-authored or pre-existing records"
                                          value={activePair.unmatchedWithoutMatchKey}
                                          onChange={(val) =>
                                            handleDestinationPolicyChange(
                                              activePairIndex,
                                              'unmatchedWithoutMatchKey',
                                              val as 'ignore' | 'apply',
                                            )
                                          }
                                          data={[
                                            { value: 'apply', label: 'Apply' },
                                            { value: 'ignore', label: 'Ignore' },
                                          ]}
                                        />
                                        <Text12Regular c="var(--fg-secondary)" fs="italic" mt={4}>
                                          Records that were never managed by this sync (hand-authored or pre-existing).
                                          Typically: don&apos;t touch.
                                        </Text12Regular>
                                      </Box>
                                    </Stack>
                                    {(activePair.unmatchedWithMatchKey === 'apply' ||
                                      activePair.unmatchedWithoutMatchKey === 'apply') &&
                                      !(activePair.matchingSourceField && activePair.matchingDestinationField) && (
                                        <Text12Regular c="var(--mantine-color-orange-7)" mt={6}>
                                          Configure record matching above — unmatched-destination rules only run when a
                                          match key is set.
                                        </Text12Regular>
                                      )}
                                  </Box>
                                </Stack>
                              </Accordion.Panel>
                            </Accordion.Item>
                          </Accordion>
                        </Stack>
                      </Box>
                      <Box style={{ width: '33.333%' }} />
                    </Box>
                  </Stack>
                )}
              </>
            )}
          </Stack>
        </ScrollArea>
      ) : (
        <Flex style={{ flex: 1, overflow: 'hidden' }}>
          <Stack style={{ flex: 1, overflow: 'hidden' }} gap={0}>
            {jsonError && (
              <Alert color="red" withCloseButton onClose={() => setJsonError(null)} mx="md" mt="md">
                {jsonError}
              </Alert>
            )}
            <Box style={{ flex: 1, overflow: 'auto' }}>
              <CodeMirror
                value={jsonContent}
                onChange={handleJsonContentChange}
                extensions={cmExtensions}
                theme={colorScheme === 'dark' ? 'dark' : 'light'}
                basicSetup={{
                  lineNumbers: true,
                  highlightActiveLineGutter: true,
                  foldGutter: true,
                  bracketMatching: true,
                  closeBrackets: true,
                  autocompletion: true,
                  highlightActiveLine: true,
                  highlightSelectionMatches: true,
                  indentOnInput: true,
                  syntaxHighlighting: true,
                }}
                style={{ fontSize: '13px', height: '100%' }}
              />
            </Box>
          </Stack>
          <SyncJsonReferencePanel
            jsonContent={jsonContent}
            allFolders={allFolders}
            hasLinkedFolders={hasLinkedFolders}
            aiContextCopying={aiContextCopying}
            onCopyAiContext={handleCopyAiContext}
          />
        </Flex>
      )}

      {/* Confirmation dialog for first ignore→apply of an unmatched-destination policy. */}
      <ConfirmDialog {...confirmDialogProps} />

      {/* Add Folder Mapping Modal */}
      <AddFolderMappingModal
        opened={folderMappingModalOpen}
        onClose={() => setFolderMappingModalOpen(false)}
        onConfirm={handleFolderMappingConfirm}
        allFolders={allFolders}
      />

      {/* Transformer Config Modal */}
      <TransformerConfigModal
        opened={transformerModalOpen}
        onClose={() => {
          setTransformerModalOpen(false);
          setEditingTransformerTarget(null);
        }}
        currentConfigs={
          editingTransformerTarget
            ? (folderPairs[editingTransformerTarget.pairIndex]?.fieldMappings[editingTransformerTarget.mappingIndex]
                ?.transformers ?? [])
            : []
        }
        onSave={(configs) => {
          if (editingTransformerTarget) {
            updateFieldMappingTransformers(
              editingTransformerTarget.pairIndex,
              editingTransformerTarget.mappingIndex,
              configs,
            );
          }
        }}
        allFolders={allFolders}
        mappingContext={
          editingTransformerTarget
            ? (() => {
                const pair = folderPairs[editingTransformerTarget.pairIndex];
                const mapping = pair?.fieldMappings[editingTransformerTarget.mappingIndex];
                if (!pair || !mapping || !workbookId) return null;
                const sourceSchema = schemaCache[pair.sourceId] || [];
                const destSchema = schemaCache[pair.destId] || [];
                const sourceFieldType = sourceSchema.find((f) => f.path === mapping.sourceField)?.type;
                const destFieldType = destSchema.find((f) => f.path === mapping.destField)?.type;
                return {
                  workbookId,
                  sourceFolderId: pair.sourceId as DataFolderId,
                  destFolderId: pair.destId as DataFolderId,
                  sourceField: mapping.sourceField,
                  destField: mapping.destField,
                  sourceFieldType,
                  destFieldType,
                };
              })()
            : null
        }
      />
    </Stack>
  );
}
