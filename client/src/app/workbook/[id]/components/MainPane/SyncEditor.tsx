'use client';

import { Text12Regular } from '@/app/components/base/text';
import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { useDataFolders } from '@/hooks/use-data-folders';
import { getHumanReadableErrorMessage } from '@/lib/api/error';
import { scheduleApi } from '@/lib/api/schedule';
import { syncApi } from '@/lib/api/sync';
import { workbookApi } from '@/lib/api/workbook';
import { useSyncStore } from '@/stores/sync-store';
import { DocsUrls } from '@/utils/docs-urls';
import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import type { ComboboxItem } from '@mantine/core';
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
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type {
  DataFolderId,
  SaveSyncBody,
  SyncId,
  SyncMapping,
  TransformerConfig,
  WorkbookId,
} from '@spinner/shared-types';
import { getTransformerLabel, ScheduleAction } from '@spinner/shared-types';
import CodeMirror from '@uiw/react-codemirror';
import { ArrowRight, ClipboardCopy, Plus, Search, Settings, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SyncJsonReferencePanel } from './SyncJsonReferencePanel';
import { SyncPreviewPanel } from './SyncPreviewPanel';
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

const renderFolderOption = ({ option }: { option: ComboboxItem & { connectorService?: string | null } }) => (
  <Group gap="xs" wrap="nowrap">
    {option.connectorService && <ConnectorIcon connector={option.connectorService} size={16} p={0} />}
    <Text size="sm">{option.label}</Text>
  </Group>
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const renderAutocompleteOption = ({ option }: any) => (
  <Group gap="sm" wrap="nowrap">
    <Badge size="xs" variant="light" color="blue" w={70} style={{ flexShrink: 0 }}>
      {option.type}
    </Badge>
    <Text size="sm">{option.value}</Text>
  </Group>
);

export function SyncEditor({ workbookId, syncId }: SyncEditorProps) {
  const router = useRouter();
  const { dataFolderGroups } = useDataFolders();
  const syncs = useSyncStore((state) => state.syncs);
  const fetchSyncs = useSyncStore((state) => state.fetchSyncs);

  const isNew = syncId === 'new';
  const existingSync = useMemo(() => syncs.find((s) => s.id === syncId), [syncs, syncId]);

  const [folderPairs, setFolderPairs] = useState<FolderPair[]>([createPair()]);
  const [selectedPairIndex, setSelectedPairIndex] = useState(0);
  const [syncName, setSyncName] = useState('');
  const [schedule, setSchedule] = useState('');
  const [autoPublish, setAutoPublish] = useState(false);
  const [enableValidation, setEnableValidation] = useState(false);

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
    return JSON.stringify({ syncName, schedule, folderPairs, editorMode, jsonContent });
  }, [syncName, schedule, folderPairs, editorMode, jsonContent]);

  const hasUnsavedChanges = isNew ? true : getCurrentStateSnapshot() !== lastSavedState;

  // Flatten folders for easy selection
  const allFolders = dataFolderGroups.flatMap((g) => g.dataFolders);

  // Derive active pair from selection
  const activePairIndex = Math.min(selectedPairIndex, folderPairs.length - 1);
  const activePair = folderPairs[activePairIndex];

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
        setFolderPairs(pairs.length ? pairs : [createPair()]);
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
      setFolderPairs([createPair()]);
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
      setFolderPairs(pairs.length ? pairs : [createPair()]);
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
      setFolderPairs(pairs.length ? pairs : [createPair()]);
    } else {
      setFolderPairs([createPair()]);
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
    if (folderPairs.length > 1) {
      setFolderPairs(folderPairs.filter((_, i) => i !== index));
      if (selectedPairIndex >= index && selectedPairIndex > 0) {
        setSelectedPairIndex(selectedPairIndex - 1);
      }
    }
  };

  const addPair = () => {
    const newPairs = [...folderPairs, createPair()];
    setFolderPairs(newPairs);
    setSelectedPairIndex(newPairs.length - 1);
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
  ) => {
    const next = [...folderPairs];
    next[pairIndex].fieldMappings[mappingIndex] = {
      ...next[pairIndex].fieldMappings[mappingIndex],
      transformer,
    };
    setFolderPairs(next);
  };

  const openTransformerModal = (pairIndex: number, mappingIndex: number) => {
    setEditingTransformerTarget({ pairIndex, mappingIndex });
    setTransformerModalOpen(true);
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
            <Group justify="space-between">
              <Group gap="sm">
                <TablePairSelector
                  folderPairs={folderPairs.map((p) => ({
                    id: p.id,
                    sourceId: p.sourceId,
                    destId: p.destId,
                    fieldMappingCount: p.fieldMappings.filter((m) => m.sourceField && m.destField).length,
                  }))}
                  selectedIndex={activePairIndex}
                  onSelect={setSelectedPairIndex}
                  onAddPair={addPair}
                  getFolderName={getFolderName}
                />
                {folderPairs.length > 1 && (
                  <ActionIcon color="red" variant="subtle" onClick={() => removePair(activePairIndex)}>
                    <Trash2 size={14} />
                  </ActionIcon>
                )}
                {activePair && (
                  <Text12Regular c="dimmed">
                    {activePair.fieldMappings.filter((m) => m.sourceField && m.destField).length} column mappings
                  </Text12Regular>
                )}
              </Group>
              <SegmentedControl
                size="xs"
                value={editorMode}
                onChange={handleModeChange}
                data={[
                  { value: 'visual', label: 'Visual' },
                  { value: 'json', label: 'JSON' },
                ]}
              />
            </Group>

            <Divider />

            {activePair && (
              <Stack key={activePair.id} gap="md">
                <Group grow>
                  <Select
                    label="Source Folder"
                    placeholder="Select source"
                    data={allFolders
                      .filter((f) => f.id !== activePair.destId)
                      .map((f) => ({ value: f.id, label: f.name, connectorService: f.connectorService }))}
                    value={activePair.sourceId}
                    onChange={(val) => {
                      updatePair(activePairIndex, { sourceId: val || '' });
                      if (val) ensureSchemaPaths(val);
                    }}
                    renderOption={renderFolderOption}
                    leftSection={
                      getFolderConnectorService(activePair.sourceId) ? (
                        <ConnectorIcon connector={getFolderConnectorService(activePair.sourceId)!} size={16} p={0} />
                      ) : undefined
                    }
                    searchable
                  />
                  <Select
                    label="Destination Folder"
                    placeholder="Select destination"
                    data={allFolders
                      .filter((f) => f.id !== activePair.sourceId)
                      .map((f) => ({ value: f.id, label: f.name, connectorService: f.connectorService }))}
                    value={activePair.destId}
                    onChange={(val) => {
                      updatePair(activePairIndex, { destId: val || '' });
                      if (val) ensureSchemaPaths(val);
                    }}
                    renderOption={renderFolderOption}
                    leftSection={
                      getFolderConnectorService(activePair.destId) ? (
                        <ConnectorIcon connector={getFolderConnectorService(activePair.destId)!} size={16} p={0} />
                      ) : undefined
                    }
                    searchable
                  />
                </Group>

                <Divider />
                <Group gap="xs">
                  <Text12Regular c="dimmed" tt="uppercase" style={{ flex: 1 }}>
                    Source field
                  </Text12Regular>
                  {/* Spacer for arrow icon */}
                  <Box w={14} />
                  <Text12Regular c="dimmed" tt="uppercase" style={{ flex: 1 }}>
                    Dest field
                  </Text12Regular>
                  {/* Spacer for action icons */}
                  <Box w={58} />
                </Group>
                <Divider />

                <Stack gap="xs">

                  {activePair.fieldMappings.map((mapping, mIndex) => (
                    <Group key={mapping.id} gap="xs">
                      <Autocomplete
                        placeholder="Source field"
                        style={{ flex: 1 }}
                        value={mapping.sourceField}
                        onChange={(val) => {
                          updateFieldMapping(activePairIndex, mIndex, 'sourceField', val);
                          const field = (schemaCache[activePair.sourceId] || []).find((f) => f.path === val);
                          if (
                            field?.suggestedTransformer &&
                            !folderPairs[activePairIndex].fieldMappings[mIndex].transformer
                          ) {
                            updateFieldMappingTransformer(activePairIndex, mIndex, field.suggestedTransformer);
                          }
                        }}
                        data={(schemaCache[activePair.sourceId] || []).map((f) => {
                          if (typeof f === 'string') return { value: f, label: f, type: 'unknown' };
                          return { value: f.path, label: f.path, type: f.type };
                        })}
                        renderOption={renderAutocompleteOption}
                        rightSection={<Search size={14} color="var(--mantine-color-dimmed)" />}
                      />
                      <ArrowRight size={14} color="var(--mantine-color-dimmed)" />
                      <Autocomplete
                        placeholder="Dest field"
                        style={{ flex: 1 }}
                        value={mapping.destField}
                        onChange={(val) => updateFieldMapping(activePairIndex, mIndex, 'destField', val)}
                        data={(schemaCache[activePair.destId] || []).map((f) => {
                          if (typeof f === 'string') return { value: f, label: f, type: 'unknown' };
                          return { value: f.path, label: f.path, type: f.type };
                        })}
                        renderOption={renderAutocompleteOption}
                        rightSection={<Search size={14} color="var(--mantine-color-dimmed)" />}
                      />
                      <Tooltip
                        label={mapping.transformer ? getTransformerLabel(mapping.transformer.type) : 'Transform'}
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
                  ))}
                  <Button
                    variant="light"
                    size="xs"
                    leftSection={<Plus size={14} />}
                    onClick={() => addFieldMapping(activePairIndex)}
                  >
                    Add Field Mapping
                  </Button>
                </Stack>

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

                <SyncPreviewPanel
                  workbookId={workbookId}
                  sourceId={activePair.sourceId}
                  fieldMappings={activePair.fieldMappings}
                />
              </Stack>
            )}
          </Stack>
        </ScrollArea>
      ) : (
        <Flex style={{ flex: 1, overflow: 'hidden' }}>
          <Stack style={{ flex: 1, overflow: 'hidden' }} gap={0}>
            <Group px="md" pt="md" pb="sm" justify="space-between">
              <Group gap="sm">
                <Tooltip
                  label={
                    hasLinkedFolders
                      ? 'Copy workbook context for an AI agent'
                      : 'Link at least one folder before using AI assist'
                  }
                >
                  <Box>
                    <Button
                      size="compact-xs"
                      variant="light"
                      leftSection={<ClipboardCopy size={12} />}
                      disabled={!hasLinkedFolders}
                      loading={aiContextCopying}
                      onClick={handleCopyAiContext}
                    >
                      Copy for AI
                    </Button>
                  </Box>
                </Tooltip>
              </Group>
              <SegmentedControl
                size="xs"
                value={editorMode}
                onChange={handleModeChange}
                data={[
                  { value: 'visual', label: 'Visual' },
                  { value: 'json', label: 'JSON' },
                ]}
              />
            </Group>
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
          <SyncJsonReferencePanel jsonContent={jsonContent} allFolders={allFolders} />
        </Flex>
      )}

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
            );
          }
        }}
        allFolders={allFolders}
      />
    </Stack>
  );
}
