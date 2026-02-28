'use client';

import { ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text12Regular } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { useDataFolders } from '@/hooks/use-data-folders';
import { useFolderFileList } from '@/hooks/use-folder-file-list';
import { getHumanReadableErrorMessage } from '@/lib/api/error';
import { scheduleApi } from '@/lib/api/schedule';
import { syncApi } from '@/lib/api/sync';
import { workbookApi } from '@/lib/api/workbook';
import { useSyncStore } from '@/stores/sync-store';
import { DocsUrls } from '@/utils/docs-urls';
import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import {
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
  ScrollArea,
  Select,
  Stack,
  Text,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type {
  AutoConvertOptions,
  ColumnMapping,
  DataFolderId,
  PreviewFieldResult,
  SaveSyncBody,
  SyncId,
  SyncMapping,
  TransformerConfig,
  WorkbookId,
} from '@spinner/shared-types';
import { getTransformerLabel, ScheduleAction, TransformerTypes } from '@spinner/shared-types';
import CodeMirror from '@uiw/react-codemirror';
import {
  AlertCircle,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Circle,
  CircleCheck,
  CornerDownRight,
  Plus,
  Search,
  Settings,
  Trash2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AddFolderMappingModal } from './AddFolderMappingModal';
import { SyncJsonReferencePanel } from './SyncJsonReferencePanel';
import { SyncToolbar } from './SyncToolbar';
import { TablePairSelector } from './TablePairSelector';
import { TransformerConfigModal } from './TransformerConfigModal';

interface SyncEditorProps {
  workbookId: WorkbookId;
  syncId: SyncId | 'new';
}

interface FieldMapping {
  id: string;
  sourceField: string;
  destField: string;
  transformer?: TransformerConfig;
  /** Optional pipeline of transformers (mutually exclusive with `transformer`) */
  transformers?: TransformerConfig[];
  /** True when the transformer was auto-applied (can be replaced when fields change) */
  transformerAutoApplied?: boolean;
  /** True when the user has explicitly cleared the transformer (opt-out of auto-applied transformer) */
  transformerClearedManually?: boolean;
}

interface FolderPair {
  id: string;
  sourceId: string;
  destId: string;
  fieldMappings: FieldMapping[];
  matchingDestinationField: string;
  matchingSourceField: string;
}

// Helpers
let mappingIdCounter = 0;
const createMapping = (sourceField = '', destField = '', transformer?: TransformerConfig): FieldMapping => ({
  id: `mapping-${++mappingIdCounter}`,
  sourceField,
  destField,
  transformer,
});

let pairIdCounter = 0;
const createPair = (): FolderPair => ({
  id: `pair-${++pairIdCounter}`,
  sourceId: '',
  destId: '',
  fieldMappings: [createMapping()],
  matchingDestinationField: '',
  matchingSourceField: '',
});

const folderPairsToSyncMapping = (pairs: FolderPair[]): SyncMapping => {
  const validPairs = pairs.filter((p) => {
    const hasValidMappings = p.fieldMappings.some((m) => m.sourceField && m.destField);
    return p.sourceId && p.destId && hasValidMappings;
  });

  return {
    version: 1,
    tableMappings: validPairs.map((pair) => {
      const columnMappings = pair.fieldMappings
        .filter((m) => m.sourceField && m.destField)
        .map((m) => ({
          sourceColumnId: m.sourceField,
          destinationColumnId: m.destField,
          ...(m.transformer ? { transformer: m.transformer } : {}),
          ...(m.transformers ? { transformers: m.transformers } : {}),
        }));

      return {
        sourceDataFolderId: pair.sourceId as DataFolderId,
        destinationDataFolderId: pair.destId as DataFolderId,
        columnMappings,
        ...(pair.matchingSourceField && pair.matchingDestinationField
          ? {
              recordMatching: {
                sourceColumnId: pair.matchingSourceField,
                destinationColumnId: pair.matchingDestinationField,
              },
            }
          : {}),
      };
    }),
  };
};

const syncMappingToFolderPairs = (mapping: SyncMapping): FolderPair[] => {
  return mapping.tableMappings.map((tm) => {
    const fieldMappings: FieldMapping[] = tm.columnMappings.map((cm) => ({
      id: `mapping-${++mappingIdCounter}`,
      sourceField: cm.sourceColumnId,
      destField: cm.destinationColumnId,
      transformer: cm.transformer,
      ...(cm.transformers ? { transformers: cm.transformers } : {}),
    }));

    return {
      id: `pair-${++pairIdCounter}`,
      sourceId: tm.sourceDataFolderId,
      destId: tm.destinationDataFolderId,
      fieldMappings: fieldMappings.length ? fieldMappings : [createMapping()],
      matchingDestinationField: tm.recordMatching?.destinationColumnId || '',
      matchingSourceField: tm.recordMatching?.sourceColumnId || '',
    };
  });
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const isSyncMapping = (obj: any): obj is SyncMapping => {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.version !== 1) return false;
  if (!Array.isArray(obj.tableMappings)) return false;
  for (const tm of obj.tableMappings) {
    if (typeof tm.sourceDataFolderId !== 'string') return false;
    if (typeof tm.destinationDataFolderId !== 'string') return false;
    if (!Array.isArray(tm.columnMappings)) return false;
    for (const cm of tm.columnMappings) {
      if (typeof cm.sourceColumnId !== 'string') return false;
      if (typeof cm.destinationColumnId !== 'string') return false;
    }
  }
  return true;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const renderAutocompleteOption = ({ option }: any) => (
  <Group gap="sm" wrap="nowrap">
    <Badge size="xs" variant="light" color="blue" w={70} style={{ flexShrink: 0 }}>
      {option.type}
    </Badge>
    <Text size="sm">{option.value}</Text>
  </Group>
);

const LINE_HEIGHT = 18;
const MAX_COLLAPSED_LINES = 3;
const MAX_COLLAPSED_HEIGHT = LINE_HEIGHT * MAX_COLLAPSED_LINES;

const formatPreviewValue = (value: unknown): string => {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
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
      <Box
        ref={sourceRef}
        style={{
          padding: '6px 10px',
          maxHeight: expanded ? undefined : MAX_COLLAPSED_HEIGHT,
          overflow: 'hidden',
        }}
      >
        <Text fz="xs" style={{ wordBreak: 'break-all', lineHeight: `${LINE_HEIGHT}px` }}>
          {formatPreviewValue(sourceValue)}
        </Text>
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
        <Group gap={6} wrap="nowrap" align="flex-start">
          <CornerDownRight size={12} color="var(--mantine-color-dimmed)" style={{ flexShrink: 0, marginTop: 3 }} />
          <Text fz="xs" c="dimmed" style={{ wordBreak: 'break-all', lineHeight: `${LINE_HEIGHT}px` }}>
            {formatPreviewValue(transformedValue)}
          </Text>
        </Group>
        {warning && (
          <Text fz={10} c="var(--mantine-color-orange-6)" mt={2}>
            ⚠ {warning}
          </Text>
        )}
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
  const { dataFolderGroups } = useDataFolders();
  const syncs = useSyncStore((state) => state.syncs);
  const fetchSyncs = useSyncStore((state) => state.fetchSyncs);

  const isNew = syncId === 'new';
  const existingSync = useMemo(() => syncs.find((s) => s.id === syncId), [syncs, syncId]);

  const [folderPairs, setFolderPairs] = useState<FolderPair[]>([]);
  const [selectedPairIndex, setSelectedPairIndex] = useState(0);
  const [syncName, setSyncName] = useState('');
  const [schedule, setSchedule] = useState('');
  const [autoPublish, setAutoPublish] = useState(false);
  const [enableValidation, setEnableValidation] = useState(false);
  const [folderMappingModalOpen, setFolderMappingModalOpen] = useState(false);

  const [saving, setSaving] = useState(false);
  const [aiContextCopying, setAiContextCopying] = useState(false);
  const [errorBanner, setErrorBanner] = useState<{ title: string; body: string } | null>(null);
  const [schemaCache, setSchemaCache] = useState<
    Record<string, { path: string; type: string; suggestedTransformer?: TransformerConfig }[]>
  >({});
  const [transformerModalOpen, setTransformerModalOpen] = useState(false);
  const [editingTransformerTarget, setEditingTransformerTarget] = useState<{
    pairIndex: number;
    mappingIndex: number;
  } | null>(null);

  // Preview & row interaction state
  const [hoveredMappingIndex, setHoveredMappingIndex] = useState<number | null>(null);
  const [selectedPreviewFile, setSelectedPreviewFile] = useState<string | null>(null);
  const [previewResults, setPreviewResults] = useState<PreviewFieldResult[] | null>(null);
  const [previewRecordId, setPreviewRecordId] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

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
    return JSON.stringify({ syncName, schedule, folderPairs, editorMode, jsonContent, autoPublish });
  }, [syncName, schedule, folderPairs, editorMode, jsonContent, autoPublish]);

  const hasUnsavedChanges = isNew ? true : getCurrentStateSnapshot() !== lastSavedState;

  // Flatten folders for easy selection
  const allFolders = dataFolderGroups.flatMap((g) => g.dataFolders);

  // Derive active pair from selection
  const activePairIndex = Math.min(selectedPairIndex, folderPairs.length - 1);
  const activePair = folderPairs[activePairIndex];

  // Preview: folder file list
  const { files: previewFiles } = useFolderFileList(workbookId, (activePair?.sourceId || null) as DataFolderId | null);

  const previewFileOptions = useMemo(
    () =>
      previewFiles
        .filter((f) => f.type === 'file' && f.path.endsWith('.json'))
        .map((f) => ({ value: f.path, label: f.name || f.path })),
    [previewFiles],
  );

  // Fetch schema paths if not in cache
  const ensureSchemaPaths = async (folderId: string) => {
    if (!folderId || schemaCache[folderId]) return;

    const paths = await workbookApi.getSchemaPaths(folderId);
    setSchemaCache((prev) => ({ ...prev, [folderId]: paths }));
  };

  const handleJsonContentChange = useCallback((value: string) => {
    setJsonContent(value);
    setJsonError(null);
  }, []);

  const handleModeChange = (newMode: string) => {
    if (newMode === editorMode) return;

    if (newMode === 'json') {
      // Visual → JSON: always succeeds
      const mapping = folderPairsToSyncMapping(folderPairs);
      const hasContent = mapping.tableMappings.length > 0;
      const jsonObj = hasContent ? mapping : { version: 1, tableMappings: [] };
      setJsonContent(JSON.stringify(jsonObj, null, 2));
      setJsonError(null);
      setEditorMode('json');
    } else {
      // JSON → Visual: parse and validate
      try {
        const parsed = JSON.parse(jsonContent);
        if (!isSyncMapping(parsed)) {
          setJsonError(
            'Invalid SyncMapping structure. Must have version: 1, tableMappings array, and each table mapping needs sourceDataFolderId, destinationDataFolderId, and columnMappings.',
          );
          return;
        }
        const pairs = syncMappingToFolderPairs(parsed);
        setFolderPairs(pairs);
        setSelectedPairIndex(0);
        // Ensure schema paths for all referenced folders
        const folderIds = new Set<string>();
        parsed.tableMappings.forEach((tm: { sourceDataFolderId: string; destinationDataFolderId: string }) => {
          folderIds.add(tm.sourceDataFolderId);
          folderIds.add(tm.destinationDataFolderId);
        });
        folderIds.forEach((id) => ensureSchemaPaths(id));
        setJsonError(null);
        setEditorMode('visual');
      } catch {
        setJsonError('Invalid JSON. Please fix syntax errors before switching to Visual mode.');
      }
    }
  };

  // Initialize from existing sync
  useEffect(() => {
    if (isNew) {
      setFolderPairs([]);
      setSyncName('');
      setSchedule('');
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
    scheduleApi
      .findByEntity(workbookId, ScheduleAction.SYNC, syncId)
      .then((syncSchedule) => {
        setSchedule(syncSchedule?.cronExpression ?? '');
      })
      .catch(() => {
        setSchedule('');
      });
    setJsonContent('');
    setJsonError(null);

    if (existingSync.mappings && existingSync.mappings.tableMappings) {
      const uniqueFolderIds = new Set<string>();
      const pairs: FolderPair[] = existingSync.mappings.tableMappings.map((tm) => {
        uniqueFolderIds.add(tm.sourceDataFolderId);
        uniqueFolderIds.add(tm.destinationDataFolderId);

        const fieldMappings: FieldMapping[] = tm.columnMappings.map((cm) => ({
          id: `mapping-${++mappingIdCounter}`,
          sourceField: cm.sourceColumnId,
          destField: cm.destinationColumnId,
          transformer: cm.transformer,
          ...(cm.transformers ? { transformers: cm.transformers } : {}),
        }));

        return {
          id: `pair-${++pairIdCounter}`,
          sourceId: tm.sourceDataFolderId,
          destId: tm.destinationDataFolderId,
          fieldMappings: fieldMappings.length ? fieldMappings : [createMapping()],
          matchingDestinationField: tm.recordMatching?.destinationColumnId || '',
          matchingSourceField: tm.recordMatching?.sourceColumnId || '',
        };
      });
      setFolderPairs(pairs);
      setSelectedPairIndex(0);
      uniqueFolderIds.forEach((id) => ensureSchemaPaths(id));
    } else if (existingSync.syncTablePairs) {
      const pairs: FolderPair[] = existingSync.syncTablePairs.map((p) => ({
        id: `pair-${++pairIdCounter}`,
        sourceId: p.sourceDataFolderId,
        destId: p.destinationDataFolderId,
        fieldMappings: [createMapping()],
        matchingDestinationField: '',
        matchingSourceField: '',
      }));
      setFolderPairs(pairs);
    } else {
      setFolderPairs([]);
    }

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncId, existingSync?.id]);

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

  // Preview: debounced auto-run
  const previewMappingsFingerprint = JSON.stringify(activePair?.fieldMappings);
  const canPreview =
    !!activePair?.sourceId &&
    activePair.fieldMappings.some((m) => m.sourceField && m.destField) &&
    !!selectedPreviewFile;

  useEffect(() => {
    if (!canPreview || !activePair) return;
    const abortController = new AbortController();
    const capturedMappings = JSON.parse(previewMappingsFingerprint) as FieldMapping[];
    const timer = setTimeout(async () => {
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const columnMappings: ColumnMapping[] = capturedMappings
          .filter((m) => m.sourceField && m.destField)
          .map((m) => ({
            sourceColumnId: m.sourceField,
            destinationColumnId: m.destField,
            ...(m.transformer ? { transformer: m.transformer } : {}),
            ...(m.transformers ? { transformers: m.transformers } : {}),
          }));
        const response = await syncApi.previewRecord(
          workbookId,
          activePair.sourceId,
          selectedPreviewFile!,
          columnMappings,
        );
        if (abortController.signal.aborted) return;
        setPreviewResults(response.fields);
        setPreviewRecordId(response.recordId);
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
  }, [canPreview, previewMappingsFingerprint, selectedPreviewFile, activePair?.sourceId, workbookId]);

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

  const validPairsCount = folderPairs.filter((p) => {
    const hasValidMappings = p.fieldMappings.some((m) => m.sourceField && m.destField);
    return p.sourceId && p.destId && hasValidMappings;
  }).length;

  const handleSave = async () => {
    setSaving(true);
    setErrorBanner(null);
    try {
      let mappings: SyncMapping;

      if (editorMode === 'json') {
        try {
          const parsed = JSON.parse(jsonContent);
          if (!isSyncMapping(parsed)) {
            setErrorBanner({
              title: 'Invalid JSON structure',
              body: 'Must have version: 1, tableMappings array, and each table mapping needs sourceDataFolderId, destinationDataFolderId, and columnMappings.',
            });
            setSaving(false);
            return;
          }
          mappings = parsed;
        } catch {
          setErrorBanner({ title: 'Invalid JSON', body: 'Please fix syntax errors before saving.' });
          setSaving(false);
          return;
        }
      } else {
        mappings = folderPairsToSyncMapping(folderPairs);
      }

      const payload: SaveSyncBody = {
        displayName: syncName.trim() || syncNamePlaceholder || 'Untitled Sync',
        mappings,
        validateMappings: enableValidation,
        schedule,
        ...(!isNew && { publishAfterSync: autoPublish }),
      };

      if (isNew) {
        const newSync = await syncApi.create(workbookId, payload);
        await fetchSyncs(workbookId);
        notifications.show({
          title: 'Sync created',
          message: `"${syncName}" has been created`,
          color: 'green',
        });
        router.push(`/workbook/${workbookId}/syncs/${newSync.id}`);
      } else {
        await syncApi.update(workbookId, syncId, payload);
        await fetchSyncs(workbookId);
        setLastSavedState(getCurrentStateSnapshot());
        notifications.show({
          title: 'Sync updated',
          message: 'Changes have been saved',
          color: 'green',
        });
      }
    } catch (error) {
      console.debug('Error saving sync:', error);
      setErrorBanner({ title: 'Failed to save sync', body: getHumanReadableErrorMessage(error) });
      throw error; // Re-throw so callers (e.g. Save & Run) can detect failure
    } finally {
      setSaving(false);
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
      const { markdown } = await syncApi.getAiContext(workbookId);
      await navigator.clipboard.writeText(markdown);
      notifications.show({ message: 'Copied AI context to clipboard', color: 'green' });
    } catch {
      notifications.show({ message: 'Failed to copy AI context', color: 'red' });
    } finally {
      setAiContextCopying(false);
    }
  };

  // -- Pair Logic -- //
  const updatePair = (index: number, changes: Partial<FolderPair>) => {
    const next = [...folderPairs];
    next[index] = { ...next[index], ...changes };
    setFolderPairs(next);
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
    const newPair = createPair();
    newPair.sourceId = sourceId;
    newPair.destId = destId;
    const newPairs = [...folderPairs, newPair];
    setFolderPairs(newPairs);
    setSelectedPairIndex(newPairs.length - 1);
    ensureSchemaPaths(sourceId);
    ensureSchemaPaths(destId);
  };

  const addFieldMapping = (pairIndex: number) => {
    const next = [...folderPairs];
    next[pairIndex].fieldMappings.push(createMapping());
    setFolderPairs(next);
  };

  const updateFieldMapping = (
    pairIndex: number,
    mappingIndex: number,
    field: 'sourceField' | 'destField',
    value: string,
  ) => {
    const next = [...folderPairs];
    next[pairIndex].fieldMappings[mappingIndex][field] = value;
    setFolderPairs(next);
  };

  const removeFieldMapping = (pairIndex: number, mappingIndex: number) => {
    const next = [...folderPairs];
    if (next[pairIndex].fieldMappings.length > 1) {
      next[pairIndex].fieldMappings = next[pairIndex].fieldMappings.filter((_, i) => i !== mappingIndex);
      setFolderPairs(next);
    }
  };

  const updateFieldMappingTransformer = (
    pairIndex: number,
    mappingIndex: number,
    transformer: TransformerConfig | undefined,
    options?: { cleared?: boolean; autoApplied?: boolean },
  ) => {
    const next = [...folderPairs];
    next[pairIndex].fieldMappings[mappingIndex] = {
      ...next[pairIndex].fieldMappings[mappingIndex],
      transformer,
      transformerClearedManually: options?.cleared ?? false,
      transformerAutoApplied: options?.autoApplied ?? false,
    };
    setFolderPairs(next);
  };

  const openTransformerModal = (pairIndex: number, mappingIndex: number) => {
    setEditingTransformerTarget({ pairIndex, mappingIndex });
    setTransformerModalOpen(true);
  };

  /**
   * Clear any auto-applied transformer so maybeAutoConvert can re-evaluate.
   * Returns true if the transformer was cleared (caller should use updated state).
   */
  const clearAutoAppliedTransformer = (pairIndex: number, mappingIndex: number): boolean => {
    const mapping = folderPairs[pairIndex].fieldMappings[mappingIndex];
    const clearTransformer = (mapping.transformer && mapping.transformerAutoApplied) ?? false;

    const next = [...folderPairs];
    const previous = next[pairIndex].fieldMappings[mappingIndex];
    next[pairIndex].fieldMappings[mappingIndex] = {
      ...previous,
      transformer: clearTransformer ? undefined : previous.transformer,
      transformerAutoApplied: clearTransformer ? false : true,
      transformerClearedManually: false,
    };
    setFolderPairs(next);

    return clearTransformer;
  };

  /**
   * Auto-apply AutoConvert transformer when source and dest field types differ.
   * @param wasAutoCleared pass true if clearAutoAppliedTransformer just cleared the transformer
   *        in this same event handler (React hasn't re-rendered yet so folderPairs is stale).
   */
  const maybeAutoConvert = (
    pairIndex: number,
    mappingIndex: number,
    sourceField: string,
    destField: string,
    wasAutoCleared?: boolean,
  ) => {
    const pair = folderPairs[pairIndex];
    const mapping = pair.fieldMappings[mappingIndex];
    if (!sourceField || !destField) return;
    if (mapping.transformerClearedManually) return;
    // If there's a non-auto-applied transformer, don't override it
    if (mapping.transformer && !mapping.transformerAutoApplied && !wasAutoCleared) return;

    const sourceSchema = schemaCache[pair.sourceId] || [];
    const destSchema = schemaCache[pair.destId] || [];
    const sourceInfo = sourceSchema.find((f) => f.path === sourceField);
    const destInfo = destSchema.find((f) => f.path === destField);
    if (!sourceInfo || !destInfo) return;
    if (sourceInfo.suggestedTransformer) return;

    if (sourceInfo.type === destInfo.type) return;

    const targetType = destInfo.type as AutoConvertOptions['targetType'];
    const validTargets: AutoConvertOptions['targetType'][] = ['string', 'number', 'integer', 'boolean', 'array'];
    if (!validTargets.includes(targetType)) return;

    updateFieldMappingTransformer(
      pairIndex,
      mappingIndex,
      { type: TransformerTypes.AutoConvert, options: { targetType } },
      { autoApplied: true },
    );
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
        onScheduleChange={setSchedule}
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
              <Stack align="center" gap="md" py="xl">
                <Text12Regular c="dimmed">No folder mappings yet</Text12Regular>
                <ButtonSecondaryOutline leftSection={<StyledLucideIcon Icon={Plus} size="sm" />} onClick={addPair}>
                  Add folder mapping
                </ButtonSecondaryOutline>
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
                          alignItems: 'center',
                        }}
                      >
                        <Group gap={8} wrap="nowrap" style={{ flex: 1 }}>
                          <Text12Regular c="dimmed" tt="uppercase" style={{ whiteSpace: 'nowrap' }}>
                            Record preview
                          </Text12Regular>
                          <Select
                            size="xs"
                            placeholder="Select file"
                            data={previewFileOptions}
                            value={selectedPreviewFile}
                            onChange={setSelectedPreviewFile}
                            searchable
                            allowDeselect={false}
                            nothingFoundMessage="No JSON files"
                            style={{ flex: 1 }}
                          />
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
                      </Box>
                    </Box>
                    <Divider style={{ position: 'relative', zIndex: 1 }} />

                    {/* Field mapping rows */}
                    {activePair.fieldMappings.map((mapping, mIndex) => {
                      const preview = getPreviewForMapping(mapping);
                      const isHovered = hoveredMappingIndex === mIndex;
                      return (
                        <Box key={mapping.id}>
                          <Box
                            style={{
                              display: 'flex',
                              width: '100%',
                              position: 'relative',
                              zIndex: 1,
                              background: isHovered ? 'var(--mantine-color-gray-0)' : undefined,
                              borderLeft: isHovered ? '3px solid var(--mantine-color-dark-7)' : '3px solid transparent',
                            }}
                            onMouseEnter={() => setHoveredMappingIndex(mIndex)}
                            onMouseLeave={() => setHoveredMappingIndex(null)}
                          >
                            {/* Left: mapping controls */}
                            <Box
                              style={{
                                width: '66.666%',
                                padding: '10px 16px 10px 13px',
                                display: 'flex',
                                alignItems: 'center',
                              }}
                            >
                              <Stack gap={2} style={{ flex: 1 }}>
                                <Group gap="xs" wrap="nowrap">
                                  <Autocomplete
                                    placeholder="Source field"
                                    style={{ flex: 1 }}
                                    value={mapping.sourceField}
                                    onChange={(val) => {
                                      updateFieldMapping(activePairIndex, mIndex, 'sourceField', val);
                                      const wasAutoCleared = clearAutoAppliedTransformer(activePairIndex, mIndex);
                                      const currentMapping = folderPairs[activePairIndex].fieldMappings[mIndex];
                                      const hasTransformer = currentMapping.transformer && !wasAutoCleared;
                                      const field = (schemaCache[activePair.sourceId] || []).find(
                                        (f) => f.path === val,
                                      );
                                      if (field?.suggestedTransformer && !hasTransformer) {
                                        updateFieldMappingTransformer(
                                          activePairIndex,
                                          mIndex,
                                          field.suggestedTransformer,
                                        );
                                      } else {
                                        maybeAutoConvert(
                                          activePairIndex,
                                          mIndex,
                                          val,
                                          mapping.destField,
                                          wasAutoCleared,
                                        );
                                      }
                                    }}
                                    data={(schemaCache[activePair.sourceId] || []).map((f) => {
                                      if (typeof f === 'string') return { value: f, label: f, type: 'unknown' };
                                      return { value: f.path, label: f.path, type: f.type };
                                    })}
                                    renderOption={renderAutocompleteOption}
                                    rightSection={<Search size={14} color="var(--mantine-color-dimmed)" />}
                                  />
                                  <ArrowRight size={14} color="var(--mantine-color-dimmed)" style={{ flexShrink: 0 }} />
                                  <Autocomplete
                                    placeholder="Dest field"
                                    style={{ flex: 1 }}
                                    value={mapping.destField}
                                    onChange={(val) => {
                                      updateFieldMapping(activePairIndex, mIndex, 'destField', val);
                                      const wasAutoCleared = clearAutoAppliedTransformer(activePairIndex, mIndex);
                                      maybeAutoConvert(
                                        activePairIndex,
                                        mIndex,
                                        mapping.sourceField,
                                        val,
                                        wasAutoCleared,
                                      );
                                    }}
                                    data={(schemaCache[activePair.destId] || []).map((f) => {
                                      if (typeof f === 'string') return { value: f, label: f, type: 'unknown' };
                                      return { value: f.path, label: f.path, type: f.type };
                                    })}
                                    renderOption={renderAutocompleteOption}
                                    rightSection={<Search size={14} color="var(--mantine-color-dimmed)" />}
                                  />
                                  <Tooltip
                                    label={
                                      mapping.transformer ? getTransformerLabel(mapping.transformer.type) : 'Transform'
                                    }
                                  >
                                    <ActionIcon
                                      variant="subtle"
                                      color={mapping.transformer ? 'blue' : 'gray'}
                                      onClick={() => openTransformerModal(activePairIndex, mIndex)}
                                    >
                                      <Settings size={14} />
                                    </ActionIcon>
                                  </Tooltip>
                                  {activePair.fieldMappings.length > 1 && (
                                    <ActionIcon
                                      variant="subtle"
                                      color="gray"
                                      onClick={() => removeFieldMapping(activePairIndex, mIndex)}
                                    >
                                      <Trash2 size={14} />
                                    </ActionIcon>
                                  )}
                                </Group>
                              </Stack>
                            </Box>
                            {/* Right: preview values */}
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
                          </Box>
                          <Divider />
                        </Box>
                      );
                    })}

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
                                .reduce<{ value: string; label: string }[]>((acc, m) => {
                                  const value = `${m.sourceField}::${m.destField}`;
                                  if (!acc.some((item) => item.value === value)) {
                                    acc.push({ value, label: `${m.sourceField} <-> ${m.destField}` });
                                  }
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
                          </Box>
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
        currentConfig={
          editingTransformerTarget
            ? folderPairs[editingTransformerTarget.pairIndex]?.fieldMappings[editingTransformerTarget.mappingIndex]
                ?.transformer
            : undefined
        }
        onSave={(config) => {
          if (editingTransformerTarget) {
            updateFieldMappingTransformer(
              editingTransformerTarget.pairIndex,
              editingTransformerTarget.mappingIndex,
              config,
              !config ? { cleared: true } : undefined, // mark as cleared when user sets to "None"
            );
          }
        }}
        allFolders={allFolders}
      />
    </Stack>
  );
}
