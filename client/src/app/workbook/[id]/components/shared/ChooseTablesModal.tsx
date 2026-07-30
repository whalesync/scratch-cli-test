'use client';

import { Badge } from '@/app/components/base/badge';
import { ButtonPrimaryLight, ButtonSecondaryInline, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text12Regular, Text13Medium, Text13Regular } from '@/app/components/base/text';
import { CapabilityIcons } from '@/app/components/Icons/CapabilityIcons';
import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { useDataFolders } from '@/hooks/use-data-folders';
import { useWorkbook } from '@/hooks/use-workbook';
import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import {
  resetFolderMutationSuppression,
  suppressFolderMutations,
  unsuppressFolderMutations,
} from '@/stores/workbook-websocket-store';
import { isTableFullyLocked, settingAppliesToTable } from '@/types/server-entities/table-list';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Divider,
  Group,
  List,
  Loader,
  Modal,
  NumberInput,
  Pill,
  ScrollArea,
  Select,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import type {
  ConnectorAccount,
  ConnectorSettingDefinition,
  DataFolderId,
  DataFolderOptions,
  TableList,
  TablePreview,
  TableSchemaPreview,
  TableSearchResult,
  WorkbookId,
} from '@spinner/shared-types';
import { TableDiscoveryMode, X_SCRATCH_CONNECTOR_DATA_TYPE } from '@spinner/shared-types';
import { ScratchpadApiError } from '@spinner/shared-types/api-client';
import { AlertTriangleIcon, InfoIcon, SearchIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';

type SchemaField = { path: string[]; label: string; type: string };

// Format a path for display. Segments containing "." are quoted so e.g.
// ["fields", "U.S. Sales"] renders as `fields → "U.S. Sales"` rather than the
// ambiguous `fields.U.S. Sales`.
function formatFieldPath(path: string[]): string {
  return path.map((seg) => (seg.includes('.') ? `"${seg}"` : seg)).join(' → ');
}

// Walk a JSON Schema, emitting one SchemaField per leaf property. Nested object properties
// produce dotted paths (e.g. "fields.Name") so the user can target them in the field selects.
// Nullable unions (anyOf/oneOf with a "null" branch) are unwrapped, matching the rest of the app.
function flattenSchemaFields(schema: unknown): SchemaField[] {
  const results: SchemaField[] = [];

  const visit = (node: Record<string, unknown> | undefined, prefix: string[]) => {
    const properties = node?.properties as Record<string, Record<string, unknown>> | undefined;
    if (!properties) return;
    for (const [name, prop] of Object.entries(properties)) {
      const path = [...prefix, name];

      // Resolve the effective type, unwrapping nullable unions.
      let type = (prop?.[X_SCRATCH_CONNECTOR_DATA_TYPE] as string) ?? (prop?.type as string);
      let effective: Record<string, unknown> = prop;
      if (!type) {
        const variants = (prop?.anyOf ?? prop?.oneOf) as Array<Record<string, unknown>> | undefined;
        const real = variants?.filter((s) => s.type !== 'null');
        if (real?.length) {
          effective = real[0];
          type = (real[0].type as string) ?? 'unknown';
        } else {
          type = 'unknown';
        }
      }

      results.push({ path: [...path], label: formatFieldPath(path), type: type ?? 'unknown' });

      // Recurse into nested objects so children are also selectable.
      if (type === 'object' && (effective.properties as Record<string, unknown> | undefined)) {
        visit(effective, path);
      }
    }
  };

  visit(schema as Record<string, unknown> | undefined, []);
  return results;
}

type TableGroup = {
  groupLabel: string | null;
  subGroups: {
    subGroupLabel: string | null;
    tables: TablePreview[];
  }[];
};

function TableLabel({ table }: { table: TablePreview }) {
  const description = table.metadata?.description as string | undefined;
  return (
    <Group gap={6} align="center" wrap="nowrap">
      <Stack gap={0}>
        <Group gap={6} align="center" wrap="nowrap">
          <Text13Regular c={table.disabled ? 'dimmed' : undefined}>{table.displayName}</Text13Regular>
          {table.disabled && (
            <Tooltip label={table.disabledReason ?? 'Not available'} multiline maw={250} position="right">
              <AlertTriangleIcon size={14} color="var(--mantine-color-dimmed)" />
            </Tooltip>
          )}
          {table.infoNote && (
            <Tooltip label={table.infoNote} multiline maw={280} position="right">
              <InfoIcon size={14} color="var(--mantine-color-dimmed)" />
            </Tooltip>
          )}
          {!table.disabled && (
            <CapabilityIcons
              disabledCreates={table.disabledCreates}
              disabledUpdates={table.disabledUpdates}
              disabledDeletes={table.disabledDeletes}
              size="sm"
            />
          )}
        </Group>
        {description && <Text12Regular c="dimmed">{description}</Text12Regular>}
      </Stack>
    </Group>
  );
}

/**
 * Groups tables by their parentPath. Splits on "/" to create group/subgroup hierarchy.
 * Returns null if no tables have a parentPath (flat list).
 */
function groupTables(tables: TablePreview[]): TableGroup[] | null {
  if (!tables.some((t) => t.parentPath)) return null;

  const groupMap = new Map<string, Map<string, TablePreview[]>>();

  for (const table of tables) {
    const parts = (table.parentPath || '').split('/');
    const group = parts[0] || '';
    const subGroup = parts.length > 1 ? parts.slice(1).join('/') : '';

    let subMap = groupMap.get(group);
    if (!subMap) {
      subMap = new Map();
      groupMap.set(group, subMap);
    }
    let tablesInSubGroup = subMap.get(subGroup);
    if (!tablesInSubGroup) {
      tablesInSubGroup = [];
      subMap.set(subGroup, tablesInSubGroup);
    }
    tablesInSubGroup.push(table);
  }

  const sorted = Array.from(groupMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  return sorted.map(([groupKey, subMap]) => ({
    groupLabel: groupKey || null,
    subGroups: Array.from(subMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([subKey, subTables]) => ({
        subGroupLabel: subMap.size > 1 ? subKey || null : null,
        tables: subTables.sort((a, b) => a.displayName.localeCompare(b.displayName)),
      })),
  }));
}

function ConnectorSettingField({
  setting,
  value,
  onChange,
}: {
  setting: ConnectorSettingDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (setting.type === 'boolean') {
    return (
      <Checkbox
        label={setting.label}
        description={setting.description}
        checked={(value as boolean) ?? false}
        onChange={(e) => onChange(e.currentTarget.checked)}
        size="xs"
      />
    );
  }
  if (setting.type === 'number') {
    return (
      <NumberInput
        label={setting.label}
        description={setting.description}
        placeholder={setting.placeholder}
        value={(value as number | '') ?? ''}
        onChange={(val) => onChange(val === '' ? '' : Number(val))}
        min={setting.min}
        max={setting.max}
        hideControls
        size="xs"
      />
    );
  }
  return (
    <TextInput
      label={setting.label}
      description={setting.description}
      placeholder={setting.placeholder}
      value={(value as string) ?? ''}
      onChange={(e) => onChange(e.currentTarget.value)}
      size="xs"
    />
  );
}

interface ChooseTablesModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
  connectorAccount: ConnectorAccount;
}

export function ChooseTablesModal({ opened, onClose, workbookId, connectorAccount }: ChooseTablesModalProps) {
  const { data, isLoading, isValidating } = useSWR<TableList>(
    opened ? SWR_KEYS.connectorAccounts.tables(workbookId, connectorAccount.id) : null,
    () => scratchApiClient.connectorAccounts.listTables(workbookId, connectorAccount.id),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
    },
  );
  const discoveryMode = data?.discoveryMode ?? TableDiscoveryMode.LIST;
  const isSearchMode = discoveryMode === TableDiscoveryMode.SEARCH;
  const availableTables = useMemo(() => data?.tables || [], [data?.tables]);
  const tablesLoading = isLoading || (isValidating && availableTables.length === 0);

  // Connector metadata from listTables response
  const supportsFilter = data?.supportsFilters ?? false;
  const supportsFieldSelection = data?.supportsFieldSelection ?? false;
  const advancedSettings = useMemo(() => data?.advancedSettings ?? [], [data?.advancedSettings]);

  // Search state for SEARCH mode
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearchTerm] = useDebouncedValue(searchTerm, 300);

  const { data: searchData, isLoading: searchLoading } = useSWR<TableSearchResult>(
    opened && isSearchMode && debouncedSearchTerm
      ? SWR_KEYS.connectorAccounts.searchTables(workbookId, connectorAccount.id, debouncedSearchTerm)
      : null,
    () => scratchApiClient.connectorAccounts.searchTables(workbookId, connectorAccount.id, debouncedSearchTerm),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      keepPreviousData: true,
    },
  );

  const { dataFolderGroups } = useDataFolders();
  const { addLinkedDataFolder, pullFolders } = useWorkbook(workbookId);

  const [step, setStep] = useState<1 | 2>(1);
  const [selectedTableIds, setSelectedTableIds] = useState<Set<string>>(new Set());
  const [selectedTableMap, setSelectedTableMap] = useState<Map<string, TablePreview>>(new Map());
  const [filterValues, setFilterValues] = useState<Map<string, string>>(new Map());
  const [isSaving, setIsSaving] = useState(false);
  const [partialResult, setPartialResult] = useState<{
    errors: { displayName: string; error: string }[];
    createdIds: DataFolderId[];
  } | null>(null);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [foldersToRemove, setFoldersToRemove] = useState<{ id: DataFolderId; name: string; tableId: string[] }[]>([]);
  const [dirtyFileCount, setDirtyFileCount] = useState(0);

  const groupedTables = useMemo(() => groupTables(availableTables), [availableTables]);
  const [fieldSelections, setFieldSelections] = useState<Map<string, { idField: string; nameField: string[] | null }>>(
    new Map(),
  );
  const [loadedTableSchemas, setLoadedTableSchemas] = useState<Map<string, TableSchemaPreview>>(new Map());
  const [schemasLoading, setSchemasLoading] = useState<Set<string>>(new Set());

  const [triggerPull, setTriggerPull] = useState(true);

  // Generic per-table connector options state
  const [connectorOptions, setConnectorOptions] = useState<Map<string, Record<string, unknown>>>(new Map());

  // Per-table user-chosen read-only toggle (separate from connector-driven lockout)
  const [readOnlyValues, setReadOnlyValues] = useState<Map<string, boolean>>(new Map());

  // Get currently linked data folders for this connector account
  const linkedFolders = useMemo(() => {
    const folders: {
      id: DataFolderId;
      name: string;
      tableId: string[];
      options: Record<string, unknown> | null;
      path: string | null;
    }[] = [];
    dataFolderGroups.forEach((group) => {
      group.dataFolders.forEach((folder) => {
        if (folder.connectorAccountId === connectorAccount.id) {
          folders.push({
            id: folder.id,
            name: folder.name,
            tableId: folder.tableId,
            options: folder.options,
            path: folder.path,
          });
        }
      });
    });
    return folders;
  }, [dataFolderGroups, connectorAccount.id]);

  // Build TablePreview[] from linked folders (for SEARCH mode -- these always show so user can unlink)
  const linkedTablePreviews: TablePreview[] = useMemo(
    () =>
      linkedFolders.map((folder) => ({
        id: { wsId: folder.name, remoteId: folder.tableId },
        displayName: folder.name,
      })),
    [linkedFolders],
  );

  // Search results (including already-linked tables, which appear pre-checked)
  const searchResultTables: TablePreview[] = useMemo(() => {
    return searchData?.tables ?? [];
  }, [searchData]);

  // Build a set of disabled table keys for quick lookup
  const disabledTableKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const table of availableTables) {
      if (table.disabled) {
        keys.add(table.id.remoteId.join('/'));
      }
    }
    return keys;
  }, [availableTables]);

  // Initialize state when modal opens (only on false→true transition)
  const prevOpenedRef = useRef(false);
  useEffect(() => {
    const justOpened = opened && !prevOpenedRef.current;
    prevOpenedRef.current = opened;
    if (!justOpened) return;

    const linked = new Set<string>();
    const initialFilters = new Map<string, string>();
    linkedFolders.forEach((folder) => {
      if (folder.tableId.length > 0) {
        const key = folder.tableId.join('/');
        if (!disabledTableKeys.has(key)) {
          linked.add(key);
        }
        const folderFilter = (folder.options as DataFolderOptions)?.filter;
        if (folderFilter) {
          initialFilters.set(key, folderFilter);
        }
      }
    });
    setSelectedTableIds(linked);
    const initialMap = new Map<string, TablePreview>();
    linkedTablePreviews.forEach((t) => {
      const key = t.id.remoteId.join('/');
      if (linked.has(key)) initialMap.set(key, t);
    });
    setSelectedTableMap(initialMap);
    setFilterValues(initialFilters);
    setFieldSelections(new Map());
    setLoadedTableSchemas(new Map());
    setSchemasLoading(new Set());
    setSearchTerm('');
    setStep(1);
    setShowConfirmation(false);

    // Initialize connector options from existing folders
    const initialOptions = new Map<string, Record<string, unknown>>();
    linkedFolders.forEach((folder) => {
      if (folder.tableId.length > 0 && advancedSettings.length > 0) {
        const key = folder.tableId.join('/');
        const opts = folder.options ?? {};
        const values: Record<string, unknown> = {};
        for (const setting of advancedSettings) {
          const stored = opts[setting.key];
          values[setting.key] = stored ?? (setting.type === 'boolean' ? false : '');
        }
        initialOptions.set(key, values);
      }
    });
    setConnectorOptions(initialOptions);

    // Initialize per-table read-only choice from existing folder options.
    const initialReadOnly = new Map<string, boolean>();
    linkedFolders.forEach((folder) => {
      if (folder.tableId.length > 0) {
        const key = folder.tableId.join('/');
        const opts = (folder.options ?? {}) as DataFolderOptions;
        initialReadOnly.set(key, Boolean(opts.readOnly));
      }
    });
    setReadOnlyValues(initialReadOnly);

    setTriggerPull(true);
    setPartialResult(null);
  }, [opened, linkedFolders, linkedTablePreviews, disabledTableKeys, advancedSettings]);

  const handleToggleTable = (table: TablePreview) => {
    if (table.disabled) return;
    const tableKey = table.id.remoteId.join('/');
    setSelectedTableIds((prev) => {
      const next = new Set(prev);
      if (next.has(tableKey)) {
        next.delete(tableKey);
      } else {
        next.add(tableKey);
      }
      return next;
    });
    setSelectedTableMap((prev) => {
      const next = new Map(prev);
      if (next.has(tableKey)) {
        next.delete(tableKey);
      } else {
        next.set(tableKey, table);
      }
      return next;
    });
  };

  const handleSelectAll = useCallback((tables: TablePreview[]) => {
    const enabledTables = tables.filter((t) => !t.disabled);
    setSelectedTableIds((prev) => {
      const next = new Set(prev);
      enabledTables.forEach((t) => next.add(t.id.remoteId.join('/')));
      return next;
    });
    setSelectedTableMap((prev) => {
      const next = new Map(prev);
      enabledTables.forEach((t) => next.set(t.id.remoteId.join('/'), t));
      return next;
    });
  }, []);

  const handleDeselectAll = useCallback((tables: TablePreview[]) => {
    const enabledTables = tables.filter((t) => !t.disabled);
    setSelectedTableIds((prev) => {
      const next = new Set(prev);
      enabledTables.forEach((t) => next.delete(t.id.remoteId.join('/')));
      return next;
    });
    setSelectedTableMap((prev) => {
      const next = new Map(prev);
      enabledTables.forEach((t) => next.delete(t.id.remoteId.join('/')));
      return next;
    });
  }, []);

  const handleFilterChange = useCallback((tableKey: string, value: string) => {
    setFilterValues((prev) => {
      const next = new Map(prev);
      if (value) {
        next.set(tableKey, value);
      } else {
        next.delete(tableKey);
      }
      return next;
    });
  }, []);

  const handleConnectorOptionChange = useCallback((tableKey: string, settingKey: string, value: unknown) => {
    setConnectorOptions((prev) => {
      const next = new Map(prev);
      const current = next.get(tableKey) ?? {};
      next.set(tableKey, { ...current, [settingKey]: value });
      return next;
    });
  }, []);

  const handleReadOnlyChange = useCallback((tableKey: string, value: boolean) => {
    setReadOnlyValues((prev) => {
      const next = new Map(prev);
      next.set(tableKey, value);
      return next;
    });
  }, []);

  // Compute tables to add and remove (used in step 2 display and save)
  const allKnownTables = useMemo(() => {
    if (!isSearchMode) return availableTables;
    const map = new Map<string, TablePreview>();
    for (const t of linkedTablePreviews) map.set(t.id.remoteId.join('/'), t);
    for (const t of searchResultTables) map.set(t.id.remoteId.join('/'), t);
    for (const [key, t] of selectedTableMap) map.set(key, t);
    return Array.from(map.values());
  }, [isSearchMode, linkedTablePreviews, searchResultTables, selectedTableMap, availableTables]);

  const tableLookup = useMemo(() => {
    const map = new Map<string, TablePreview>();
    for (const t of allKnownTables) map.set(t.id.remoteId.join('/'), t);
    return map;
  }, [allKnownTables]);

  // The effective per-folder readOnly is either the user's toggle or the connector
  // lockout (all three write capabilities disabled). The latter wins.
  const computeEffectiveReadOnly = useCallback(
    (tableKey: string): boolean => {
      if (isTableFullyLocked(tableLookup.get(tableKey))) return true;
      return readOnlyValues.get(tableKey) ?? false;
    },
    [tableLookup, readOnlyValues],
  );

  // Builds the folder.options blob we will send to the server for a given table.
  // Preserves any existing options on the folder (so unrelated keys like
  // idFieldOverride survive the round-trip) and overlays the user's read-only
  // choice plus any advanced connector-setting values.
  const buildOptionsForTable = useCallback(
    (tableKey: string): Record<string, unknown> => {
      const existing = linkedFolders.find((f) => f.tableId.join('/') === tableKey)?.options ?? {};
      const opts: Record<string, unknown> = { ...existing };

      if (computeEffectiveReadOnly(tableKey)) {
        opts.readOnly = true;
      } else {
        delete opts.readOnly;
      }

      const tableOpts = connectorOptions.get(tableKey) ?? {};
      for (const setting of advancedSettings) {
        const value = tableOpts[setting.key];
        if (setting.type === 'boolean' && value === true) {
          opts[setting.key] = true;
        } else if (setting.type === 'number' && value !== '' && value != null) {
          opts[setting.key] = value;
        } else if (setting.type === 'string' && typeof value === 'string' && value.trim()) {
          opts[setting.key] = value.trim();
        } else {
          delete opts[setting.key];
        }
      }

      return opts;
    },
    [advancedSettings, connectorOptions, linkedFolders, computeEffectiveReadOnly],
  );

  const currentlyLinkedKeys = useMemo(() => new Set(linkedFolders.map((f) => f.tableId.join('/'))), [linkedFolders]);

  const newlySelectedTables = useMemo(
    () => Array.from(selectedTableMap.values()).filter((t) => !currentlyLinkedKeys.has(t.id.remoteId.join('/'))),
    [selectedTableMap, currentlyLinkedKeys],
  );

  const tablesToAdd = useMemo(
    () =>
      allKnownTables.filter((table) => {
        const tableKey = table.id.remoteId.join('/');
        return selectedTableIds.has(tableKey) && !currentlyLinkedKeys.has(tableKey);
      }),
    [allKnownTables, selectedTableIds, currentlyLinkedKeys],
  );

  // Fetch table schema when entering step 2 for newly selected tables from field-selection connectors
  useEffect(() => {
    if (step !== 2 || !supportsFieldSelection) return;

    for (const table of tablesToAdd) {
      const tableKey = table.id.remoteId.join('/');
      if (loadedTableSchemas.has(tableKey) || schemasLoading.has(tableKey)) continue;

      setSchemasLoading((prev) => new Set(prev).add(tableKey));

      scratchApiClient.connectorAccounts
        .getTableSchema(workbookId, connectorAccount.id, table.id.remoteId.join(','))
        .then((result) => {
          setLoadedTableSchemas((prev) => new Map(prev).set(tableKey, result));
          // Pre-populate selections with detected defaults if not already set
          setFieldSelections((prev) => {
            if (prev.has(tableKey)) return prev;
            const next = new Map(prev);
            // titlePath / idPath are lodash dot paths (DEV-10092). Fall back to the
            // legacy names (titleColumnRemoteId segment array / idColumnRemoteId) for
            // responses from a server predating the rename. nameField is a segment
            // array, so split the dot path back into segments.
            const detectedTitlePath =
              result.titlePath ?? (result.titleColumnRemoteId ? result.titleColumnRemoteId.join('.') : undefined);
            const detectedNameField = detectedTitlePath ? detectedTitlePath.split('.') : null;
            // A spec flagged idPathRequiresUserSelection has no trustworthy id —
            // leave the ID field empty so the user must choose one (the server
            // rejects folder creation for such tables without an override).
            const detectedIdField = result.idPathRequiresUserSelection
              ? ''
              : (result.idPath ?? result.idColumnRemoteId ?? '');
            next.set(tableKey, {
              idField: detectedIdField,
              nameField: detectedNameField,
            });
            return next;
          });
        })
        .catch((error) => {
          console.debug('Failed to fetch table schema', tableKey, error);
        })
        .finally(() => {
          setSchemasLoading((prev) => {
            const next = new Set(prev);
            next.delete(tableKey);
            return next;
          });
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, supportsFieldSelection, tablesToAdd, workbookId, connectorAccount.id]);

  const handleFieldSelectionChange = useCallback(
    (tableKey: string, field: 'idField' | 'nameField', value: string | string[] | null) => {
      setFieldSelections((prev) => {
        const next = new Map(prev);
        const current = next.get(tableKey) ?? { idField: '', nameField: null };
        next.set(tableKey, { ...current, [field]: value });
        return next;
      });
    },
    [],
  );

  const pendingFoldersToRemove = useMemo(
    () =>
      linkedFolders.filter((folder) => {
        const folderKey = folder.tableId.join('/');
        return !selectedTableIds.has(folderKey);
      }),
    [linkedFolders, selectedTableIds],
  );

  const getTableLabel = useCallback((table: TablePreview) => {
    if (table.parentPath) {
      return `${table.parentPath} / ${table.displayName}`;
    }
    return table.displayName;
  }, []);

  // Tables that remain selected (both existing and new) for step 2 display
  const selectedTablesForStep2 = useMemo(() => {
    const tables: {
      tableKey: string;
      displayName: string;
      label: string;
      isNew: boolean;
      isRemoved: boolean;
      isFullyLocked: boolean;
    }[] = [];
    const seen = new Set<string>();

    // Existing linked folders first
    linkedFolders.forEach((folder) => {
      const key = folder.tableId.join('/');
      if (seen.has(key)) return;
      seen.add(key);
      const isRemoved = !selectedTableIds.has(key);
      const preview = tableLookup.get(key);
      const label = preview ? getTableLabel(preview) : folder.name;
      tables.push({
        tableKey: key,
        displayName: folder.name,
        label,
        isNew: false,
        isRemoved,
        isFullyLocked: isTableFullyLocked(preview),
      });
    });

    // Newly added tables
    tablesToAdd.forEach((table) => {
      const key = table.id.remoteId.join('/');
      if (seen.has(key)) return;
      seen.add(key);
      tables.push({
        tableKey: key,
        displayName: table.displayName,
        label: getTableLabel(table),
        isNew: true,
        isRemoved: false,
        isFullyLocked: isTableFullyLocked(table),
      });
    });

    return tables;
  }, [linkedFolders, selectedTableIds, tablesToAdd, tableLookup, getTableLabel]);

  const handleNext = () => {
    setStep(2);
  };

  const handleBack = () => {
    setPartialResult(null);
    setStep(1);
  };

  const handlePullPartial = useCallback(() => {
    if (partialResult?.createdIds.length) {
      void pullFolders(partialResult.createdIds);
    }
    unsuppressFolderMutations(workbookId);
    onClose();
  }, [partialResult, pullFolders, workbookId, onClose]);

  const handleSkipPull = useCallback(() => {
    unsuppressFolderMutations(workbookId);
    onClose();
  }, [workbookId, onClose]);

  const handleSave = async () => {
    // If there are folders to remove, check for dirty files and show confirmation
    if (pendingFoldersToRemove.length > 0 && !showConfirmation) {
      try {
        const dirtyFiles = await scratchApiClient.git.getStatus(workbookId);

        const folderPaths = new Set(pendingFoldersToRemove.map((f) => (f.path ?? f.name).replace(/^\//, '')));
        const dirtyInRemovedFolders = dirtyFiles.filter((file) => {
          return Array.from(folderPaths).some((folderPath) => {
            const prefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
            return file.path.startsWith(prefix);
          });
        });

        setFoldersToRemove(pendingFoldersToRemove);
        setDirtyFileCount(dirtyInRemovedFolders.length);
        setShowConfirmation(true);
        return;
      } catch (error) {
        console.error('Failed to check dirty files:', error);
      }
    }

    setIsSaving(true);
    suppressFolderMutations();
    const createdFolderIds: DataFolderId[] = [];
    const tableFailures: { displayName: string; error: string }[] = [];
    try {
      // Add new tables (with optional filter, field overrides, and connector options)
      // Create all folders first with triggerPull=false, then trigger a single pull job for all.
      // Each table is attempted independently — a scope error on one table won't block others.
      for (const table of tablesToAdd) {
        const tableKey = table.id.remoteId.join('/');
        const filter = filterValues.get(tableKey)?.trim() || undefined;
        const fields = fieldSelections.get(tableKey);
        const idFieldOverride = fields?.idField || undefined;
        const nameFieldOverride = fields?.nameField || undefined;
        let options = buildOptionsForTable(tableKey);
        // GENERIC_API: probe the endpoint before persisting the folder so the
        // connector's pull/fetch can rely on probe data (pagination strategy,
        // idPath, inferred schema). table.id.wsId is the stable
        // endpoint UUID from extras.endpoints — set by the connector class.
        if (connectorAccount.service === 'GENERIC_API') {
          try {
            const probeResult = await scratchApiClient.generic.probeEndpoint(
              workbookId,
              connectorAccount.id,
              table.id.wsId,
            );
            options = {
              ...options,
              genericApi: { endpointId: table.id.wsId, probe: probeResult.probe },
            };
          } catch (probeError) {
            const message = probeError instanceof ScratchpadApiError ? probeError.message : 'Probe failed.';
            tableFailures.push({ displayName: table.displayName, error: `Probe failed: ${message}` });
            continue;
          }
        }
        try {
          const created = await addLinkedDataFolder(
            table.id.remoteId,
            table.displayName,
            connectorAccount.id,
            filter,
            idFieldOverride,
            nameFieldOverride,
            options,
            false, // defer pull until all folders are created
          );
          createdFolderIds.push(created.id as DataFolderId);
        } catch (tableError) {
          const message = tableError instanceof ScratchpadApiError ? tableError.message : 'Failed to add table.';
          tableFailures.push({ displayName: table.displayName, error: message });
        }
      }

      // Update filters and connector options on existing tables that changed.
      // The new options blob preserves existing keys, so it is safe to send
      // whenever anything in it has changed (filter, readOnly, advanced settings).
      for (const folder of linkedFolders) {
        const folderKey = folder.tableId.join('/');
        if (!selectedTableIds.has(folderKey)) continue; // being removed
        const newFilter = filterValues.get(folderKey)?.trim() || null;
        const existingFilter = (folder.options as DataFolderOptions)?.filter || null;
        const newOptions = buildOptionsForTable(folderKey);
        const filterChanged = newFilter !== existingFilter;
        const optionsChanged = JSON.stringify(newOptions) !== JSON.stringify(folder.options ?? {});
        if (filterChanged || optionsChanged) {
          await scratchApiClient.dataFolders.update(folder.id, {
            filter: newFilter,
            options: newOptions,
          });
        }
      }

      // Remove unselected tables
      const toRemove = showConfirmation ? foldersToRemove : pendingFoldersToRemove;
      for (const folder of toRemove) {
        await scratchApiClient.dataFolders.delete(folder.id);
      }

      setShowConfirmation(false);

      if (tableFailures.length > 0) {
        // Some tables were added but others failed. Keep the modal open so the user
        // can choose whether to pull the succeeded tables. Don't trigger the pull job
        // here — that causes navigation away from the modal.
        setPartialResult({ errors: tableFailures, createdIds: createdFolderIds });
        resetFolderMutationSuppression();
        setIsSaving(false);
        return;
      }

      // All tables succeeded — trigger pull then close.
      if (triggerPull !== false && createdFolderIds.length > 0) {
        await pullFolders(createdFolderIds);
      }
      onClose();
    } catch (error) {
      console.error('Failed to update tables:', error);
      ScratchpadNotifications.error({
        title: 'Failed to save tables',
        message: error instanceof ScratchpadApiError ? error.message : 'Please try again.',
        autoClose: false,
      });
      unsuppressFolderMutations(workbookId);
      setIsSaving(false);
      return;
    }
    unsuppressFolderMutations(workbookId);
    setIsSaving(false);
  };

  const handleCancelConfirmation = () => {
    setShowConfirmation(false);
    setFoldersToRemove([]);
    setDirtyFileCount(0);
  };

  const connectionName = connectorAccount.displayName;

  const connectorTitle = (
    <Group gap="xs" align="center">
      <ConnectorIcon connector={connectorAccount.service} size={20} p={0} />
      <Text fw={600}>{connectionName}</Text>
    </Group>
  );

  const modalTitle = showConfirmation ? 'Confirm removal' : connectorTitle;

  // Check if all enabled tables are selected (for Select All / Deselect All toggle)
  const enabledTables = useMemo(() => availableTables.filter((t) => !t.disabled), [availableTables]);
  const allEnabledSelected = useMemo(
    () => enabledTables.length > 0 && enabledTables.every((t) => selectedTableIds.has(t.id.remoteId.join('/'))),
    [enabledTables, selectedTableIds],
  );

  // Step 1: Table selection (LIST mode)
  const renderStep1List = () => (
    <Stack gap="md">
      <Group justify="space-between" align="center">
        <Text13Regular c="dimmed">Pick the tables from {connectionName} to make available in Scratch.</Text13Regular>
        <Group gap="sm" align="center">
          {!tablesLoading && enabledTables.length > 1 && (
            <ButtonSecondaryInline
              onClick={() => (allEnabledSelected ? handleDeselectAll(enabledTables) : handleSelectAll(enabledTables))}
            >
              {allEnabledSelected ? 'Deselect all' : 'Select all'}
            </ButtonSecondaryInline>
          )}
          <Text12Regular c="dimmed">Step 1 of 2</Text12Regular>
        </Group>
      </Group>

      {tablesLoading ? (
        <Group justify="center" py="xl">
          <Loader size="sm" />
          <Text13Regular c="dimmed">Loading tables...</Text13Regular>
        </Group>
      ) : availableTables.length === 0 ? (
        <Text13Regular c="dimmed" ta="center" py="xl">
          No tables available for this connection
        </Text13Regular>
      ) : (
        <ScrollArea.Autosize mah={400}>
          <Stack gap="xs">
            {groupedTables
              ? groupedTables.map((group, gi) => {
                  const groupEnabledTables = group.subGroups.flatMap((sg) => sg.tables.filter((t) => !t.disabled));
                  const allGroupSelected =
                    groupEnabledTables.length > 0 &&
                    groupEnabledTables.every((t) => selectedTableIds.has(t.id.remoteId.join('/')));
                  return (
                    <Box key={group.groupLabel ?? gi}>
                      {group.groupLabel && (
                        <Group gap="xs" align="center" mb={4} mt={gi > 0 ? 'sm' : 0}>
                          <Text13Medium>{group.groupLabel}</Text13Medium>
                          {groupEnabledTables.length > 1 && (
                            <ButtonSecondaryInline
                              onClick={() =>
                                allGroupSelected
                                  ? handleDeselectAll(groupEnabledTables)
                                  : handleSelectAll(groupEnabledTables)
                              }
                            >
                              {allGroupSelected ? 'Deselect all' : 'Select all'}
                            </ButtonSecondaryInline>
                          )}
                        </Group>
                      )}
                      {group.subGroups.map((sg, si) => (
                        <Box key={sg.subGroupLabel ?? si} ml={group.groupLabel ? 'xs' : 0}>
                          {sg.subGroupLabel && (
                            <Text12Regular c="dimmed" mb={2} mt={4}>
                              {sg.subGroupLabel}
                            </Text12Regular>
                          )}
                          <Stack gap={4} ml={sg.subGroupLabel ? 'xs' : 0}>
                            {sg.tables.map((table) => {
                              const tableKey = table.id.remoteId.join('/');
                              const isChecked = selectedTableIds.has(tableKey);
                              return (
                                <Checkbox
                                  key={tableKey}
                                  label={<TableLabel table={table} />}
                                  checked={isChecked}
                                  disabled={table.disabled}
                                  onChange={() => handleToggleTable(table)}
                                />
                              );
                            })}
                          </Stack>
                        </Box>
                      ))}
                    </Box>
                  );
                })
              : availableTables.map((table) => {
                  const tableKey = table.id.remoteId.join('/');
                  const isChecked = selectedTableIds.has(tableKey);

                  return (
                    <Checkbox
                      key={tableKey}
                      label={<TableLabel table={table} />}
                      checked={isChecked}
                      disabled={table.disabled}
                      onChange={() => handleToggleTable(table)}
                    />
                  );
                })}
          </Stack>
        </ScrollArea.Autosize>
      )}

      <Group justify="flex-end" gap="sm" mt="md">
        <ButtonSecondaryOutline onClick={onClose}>Cancel</ButtonSecondaryOutline>
        <ButtonPrimaryLight
          onClick={handleNext}
          disabled={selectedTableIds.size === 0 && pendingFoldersToRemove.length === 0}
        >
          Next
        </ButtonPrimaryLight>
      </Group>
    </Stack>
  );

  // Step 1: Table selection (SEARCH mode)
  const renderStep1Search = () => (
    <Stack gap="md">
      <Group justify="space-between" align="center">
        <Text13Regular c="dimmed">Search for databases in {connectionName} to make available in Scratch.</Text13Regular>
        <Text12Regular c="dimmed">Step 1 of 2</Text12Regular>
      </Group>

      {tablesLoading ? (
        <Group justify="center" py="xl">
          <Loader size="sm" />
          <Text13Regular c="dimmed">Loading...</Text13Regular>
        </Group>
      ) : (
        <>
          {!debouncedSearchTerm && linkedTablePreviews.length > 0 && (
            <Stack gap="xs">
              <Text13Medium>Linked tables</Text13Medium>
              {linkedTablePreviews.map((table) => {
                const tableKey = table.id.remoteId.join('/');
                const isChecked = selectedTableIds.has(tableKey);
                return (
                  <Checkbox
                    key={tableKey}
                    label={<Text13Regular>{table.displayName}</Text13Regular>}
                    checked={isChecked}
                    onChange={() => handleToggleTable(table)}
                  />
                );
              })}
            </Stack>
          )}

          <TextInput
            placeholder="Search for databases..."
            leftSection={<SearchIcon size={16} />}
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.currentTarget.value)}
            autoFocus
          />

          {newlySelectedTables.length > 0 && (
            <Group gap={6} wrap="wrap">
              <Text12Regular c="dimmed">Selected:</Text12Regular>
              {newlySelectedTables.map((table) => (
                <Pill
                  key={table.id.remoteId.join('/')}
                  withRemoveButton
                  onRemove={() => handleToggleTable(table)}
                  size="sm"
                >
                  {table.displayName}
                </Pill>
              ))}
            </Group>
          )}

          {searchLoading && debouncedSearchTerm ? (
            <Group justify="center" py="md">
              <Loader size="sm" />
              <Text13Regular c="dimmed">Searching...</Text13Regular>
            </Group>
          ) : debouncedSearchTerm && searchResultTables.length > 0 ? (
            <>
              <ScrollArea.Autosize mah={300}>
                <Stack gap="xs">
                  {searchResultTables.map((table) => {
                    const tableKey = table.id.remoteId.join('/');
                    const isChecked = selectedTableIds.has(tableKey);
                    return (
                      <Checkbox
                        key={tableKey}
                        label={<TableLabel table={table} />}
                        checked={isChecked}
                        disabled={table.disabled}
                        onChange={() => handleToggleTable(table)}
                      />
                    );
                  })}
                </Stack>
              </ScrollArea.Autosize>
              {searchData?.hasMore && (
                <Text12Regular c="dimmed">
                  Showing first {searchResultTables.length.toLocaleString()} results. Refine your search for more
                  specific results.
                </Text12Regular>
              )}
            </>
          ) : debouncedSearchTerm ? (
            <Text13Regular c="dimmed" ta="center" py="md">
              No databases found
            </Text13Regular>
          ) : availableTables.length > 0 ? (
            <ScrollArea.Autosize mah={300}>
              <Stack gap="xs">
                {availableTables.map((table) => {
                  const tableKey = table.id.remoteId.join('/');
                  const isChecked = selectedTableIds.has(tableKey);
                  return (
                    <Checkbox
                      key={tableKey}
                      label={<TableLabel table={table} />}
                      checked={isChecked}
                      disabled={table.disabled}
                      onChange={() => handleToggleTable(table)}
                    />
                  );
                })}
              </Stack>
            </ScrollArea.Autosize>
          ) : (
            <Text13Regular c="dimmed" ta="center" py="md">
              Type to search for databases
            </Text13Regular>
          )}
        </>
      )}

      <Group justify="flex-end" gap="sm" mt="md">
        <ButtonSecondaryOutline onClick={onClose}>Cancel</ButtonSecondaryOutline>
        <ButtonPrimaryLight
          onClick={handleNext}
          disabled={selectedTableIds.size === 0 && pendingFoldersToRemove.length === 0}
        >
          Next
        </ButtonPrimaryLight>
      </Group>
    </Stack>
  );

  // Step 2: Configure table settings
  const renderStep2 = () => {
    return (
      <Stack gap="md">
        <Group justify="space-between" align="center">
          <Text13Regular c="dimmed">Configure settings for selected tables.</Text13Regular>
          <Text12Regular c="dimmed">Step 2 of 2</Text12Regular>
        </Group>

        <ScrollArea.Autosize mah={400}>
          <Stack gap="sm">
            {selectedTablesForStep2.map((entry, index) => {
              const tableSchema = loadedTableSchemas.get(entry.tableKey);
              const isLoadingSchema = schemasLoading.has(entry.tableKey);
              const currentSelection = fieldSelections.get(entry.tableKey);
              const showFieldSelectors = supportsFieldSelection && entry.isNew && !entry.isRemoved;

              // Extract field names/types from schema properties, unwrapping nullable unions and
              // recursing into nested object properties so paths like "fields.Name" are selectable.
              const schemaFields = tableSchema ? flattenSchemaFields(tableSchema.schema) : [];

              return (
                <Box key={entry.tableKey}>
                  {index > 0 && <Divider mb="sm" />}
                  <Stack gap="xs">
                    <Group gap="xs" align="center">
                      <Text13Medium c={entry.isRemoved ? 'dimmed' : undefined}>{entry.label}</Text13Medium>
                      {entry.isRemoved && <Badge color="red">Will be removed</Badge>}
                      {entry.isNew && <Badge color="green">New</Badge>}
                      {!entry.isRemoved && (
                        <CapabilityIcons
                          readOnly={entry.isFullyLocked || (readOnlyValues.get(entry.tableKey) ?? false)}
                          disabledCreates={tableLookup.get(entry.tableKey)?.disabledCreates}
                          disabledUpdates={tableLookup.get(entry.tableKey)?.disabledUpdates}
                          disabledDeletes={tableLookup.get(entry.tableKey)?.disabledDeletes}
                          size="sm"
                        />
                      )}
                    </Group>

                    {!entry.isRemoved && (
                      <Stack gap={4}>
                        <Text size="sm" fw={500}>
                          Read-only
                        </Text>
                        <Group gap={8} wrap="nowrap" align="center">
                          <Tooltip
                            label="This connector doesn't support writes to this table."
                            disabled={!entry.isFullyLocked}
                            position="right"
                          >
                            <Switch
                              checked={entry.isFullyLocked || (readOnlyValues.get(entry.tableKey) ?? false)}
                              disabled={entry.isFullyLocked}
                              onChange={(e) => handleReadOnlyChange(entry.tableKey, e.currentTarget.checked)}
                              size="xs"
                            />
                          </Tooltip>
                          <Text size="xs" c="dimmed">
                            {entry.isFullyLocked || (readOnlyValues.get(entry.tableKey) ?? false)
                              ? `Scratch will not push changes to ${connectionName}`
                              : `Scratch will be able to push to ${connectionName}`}
                          </Text>
                        </Group>
                      </Stack>
                    )}

                    {showFieldSelectors && isLoadingSchema && (
                      <Group gap="xs" py="xs">
                        <Loader size="xs" />
                        <Text12Regular c="dimmed">Loading table schema...</Text12Regular>
                      </Group>
                    )}

                    {showFieldSelectors && tableSchema && (
                      <>
                        {(() => {
                          // Mantine <Select> values must be strings, but our paths are arrays
                          // that may contain ".". We use the option's index as the synthetic
                          // value and look up the real path on selection — fully lossless.
                          const options = schemaFields.map((f, i) => ({
                            value: String(i),
                            label: `${f.label} (${f.type})`,
                          }));
                          const findIndexByPath = (path: string[] | null | undefined) => {
                            if (!path) return null;
                            const i = schemaFields.findIndex(
                              (f) => f.path.length === path.length && f.path.every((seg, j) => seg === path[j]),
                            );
                            return i >= 0 ? String(i) : null;
                          };
                          const currentIdPath = currentSelection?.idField
                            ? [currentSelection.idField]
                            : [tableSchema.idPath ?? tableSchema.idColumnRemoteId ?? ''];
                          return (
                            <>
                              <Select
                                label="ID field"
                                description="Column used to uniquely identify each record"
                                data={options}
                                value={findIndexByPath(currentIdPath)}
                                onChange={(value) => {
                                  const picked = value != null ? schemaFields[Number(value)] : null;
                                  // ID field is stored as a single string; join with "." for nested
                                  // paths. Connectors that only understand top-level IDs will ignore
                                  // nested selections, but the picker no longer hides them.
                                  handleFieldSelectionChange(
                                    entry.tableKey,
                                    'idField',
                                    picked ? picked.path.join('.') : null,
                                  );
                                }}
                                allowDeselect={false}
                                size="xs"
                                searchable
                              />
                              <Select
                                label="Name field (optional)"
                                description="Column used for filenames. Leave empty to use the ID."
                                data={options}
                                value={findIndexByPath(currentSelection?.nameField)}
                                onChange={(value) => {
                                  const picked = value != null ? schemaFields[Number(value)] : null;
                                  handleFieldSelectionChange(entry.tableKey, 'nameField', picked ? picked.path : null);
                                }}
                                placeholder="None (use ID for filenames)"
                                clearable
                                size="xs"
                                searchable
                              />
                            </>
                          );
                        })()}
                      </>
                    )}

                    {!entry.isRemoved && supportsFilter && (
                      <Textarea
                        label="Filter (optional)"
                        description="Leave blank to pull all records, or enter a filter expression to limit which records are pulled."
                        placeholder="Enter filter expression..."
                        value={filterValues.get(entry.tableKey) ?? ''}
                        onChange={(e) => handleFilterChange(entry.tableKey, e.currentTarget.value)}
                        autosize
                        minRows={2}
                        maxRows={4}
                      />
                    )}

                    {!entry.isRemoved &&
                      advancedSettings
                        .filter((setting) => settingAppliesToTable(setting, tableLookup.get(entry.tableKey)?.id.wsId))
                        .map((setting) => (
                          <ConnectorSettingField
                            key={setting.key}
                            setting={setting}
                            value={connectorOptions.get(entry.tableKey)?.[setting.key]}
                            onChange={(val) => handleConnectorOptionChange(entry.tableKey, setting.key, val)}
                          />
                        ))}
                  </Stack>
                </Box>
              );
            })}
          </Stack>
        </ScrollArea.Autosize>

        {partialResult ? (
          <>
            <Alert icon={<AlertTriangleIcon size={16} />} color="red" variant="light" mt="sm">
              <Text size="sm" fw={500} mb={4}>
                Some tables could not be added:
              </Text>
              {partialResult.errors.map((e) => (
                <Text key={e.displayName} size="sm">
                  • {e.displayName}: {e.error}
                </Text>
              ))}
            </Alert>
            <Group justify="flex-end" gap="sm" mt="md">
              <ButtonSecondaryOutline onClick={handleSkipPull}>Close without pulling</ButtonSecondaryOutline>
              {partialResult.createdIds.length > 0 && (
                <ButtonPrimaryLight onClick={handlePullPartial}>
                  Pull {partialResult.createdIds.length} succeeded{' '}
                  {partialResult.createdIds.length === 1 ? 'table' : 'tables'}
                </ButtonPrimaryLight>
              )}
            </Group>
          </>
        ) : (
          <Group justify="space-between" mt="md">
            <Tooltip label="Immediately start pulling files for the new tables after saving">
              <Switch
                label="Pull files"
                checked={triggerPull}
                onChange={(e) => setTriggerPull(e.currentTarget.checked)}
                size="xs"
              />
            </Tooltip>
            <Group gap="sm">
              <ButtonSecondaryOutline onClick={handleBack}>Back</ButtonSecondaryOutline>
              <ButtonPrimaryLight onClick={handleSave} loading={isSaving}>
                Save
              </ButtonPrimaryLight>
            </Group>
          </Group>
        )}
      </Stack>
    );
  };

  // Confirmation step (removal with dirty files)
  const renderConfirmation = () => (
    <Stack gap="md">
      <Alert icon={<AlertTriangleIcon size={16} />} color="orange" variant="light">
        <Text size="sm" fw={500} mb="xs">
          These folders will no longer be available in Scratch:
        </Text>
        <List size="sm" spacing={4}>
          {foldersToRemove.map((folder) => (
            <List.Item key={folder.id}>{folder.name}</List.Item>
          ))}
        </List>
        {dirtyFileCount > 0 && (
          <Text size="sm" c="orange" mt="sm" fw={500}>
            There {dirtyFileCount === 1 ? 'is' : 'are'} {dirtyFileCount.toLocaleString()} file
            {dirtyFileCount === 1 ? '' : 's'} with unpublished changes that will be discarded.
          </Text>
        )}
      </Alert>

      <Group justify="flex-end" gap="sm" mt="md">
        <Button variant="subtle" color="gray" onClick={handleCancelConfirmation}>
          Go back
        </Button>
        <Button color="red" onClick={handleSave} loading={isSaving}>
          Remove
        </Button>
      </Group>
    </Stack>
  );

  const renderContent = () => {
    if (showConfirmation) return renderConfirmation();
    if (step === 2) return renderStep2();
    if (isSearchMode) return renderStep1Search();
    return renderStep1List();
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={modalTitle}
      size="lg"
      centered
      closeOnEscape={!isSaving}
      closeOnClickOutside={!isSaving}
    >
      {renderContent()}
    </Modal>
  );
}
