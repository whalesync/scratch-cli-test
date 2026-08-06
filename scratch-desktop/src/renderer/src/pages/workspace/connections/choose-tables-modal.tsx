import { ButtonPrimaryLight, ButtonSecondaryInline, ButtonSecondaryOutline } from '@/components/base/buttons';
import { Text12Regular, Text13Medium, Text13Regular } from '@/components/base/text';
import { CapabilityIcons } from '@/components/icons/CapabilityIcons';
import { ConnectorIcon } from '@/components/icons/ConnectorIcon';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { useDataFolders } from '@/hooks/use-data-folders';
import { isTableFullyLocked } from '@/lib/connector-table-helpers';
import { scratchApiClient } from '@/lib/scratch-api-client';
import {
  Alert,
  Badge,
  Box,
  Checkbox,
  Divider,
  Group,
  List,
  Loader,
  Modal,
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
  DataFolderOptions,
  TableList,
  TablePreview,
  TableSchemaPreview,
  TableSearchResult,
  WorkbookId,
} from '@spinner/shared-types';
import { settingAppliesToTable, TableDiscoveryMode, X_SCRATCH_CONNECTOR_DATA_TYPE } from '@spinner/shared-types';
import { AlertTriangleIcon, InfoIcon, SearchIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { ConnectorSettingField } from './connector-setting-field';

type SchemaField = { path: string[]; label: string; type: string };

function formatFieldPath(path: string[]): string {
  return path.map((seg) => (seg.includes('.') ? `"${seg}"` : seg)).join(' \u2192 ');
}

function flattenSchemaFields(schema: unknown): SchemaField[] {
  const results: SchemaField[] = [];
  const visit = (node: Record<string, unknown> | undefined, prefix: string[]) => {
    const properties = node?.properties as Record<string, Record<string, unknown>> | undefined;
    if (!properties) return;
    for (const [name, prop] of Object.entries(properties)) {
      const path = [...prefix, name];
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
  subGroups: { subGroupLabel: string | null; tables: TablePreview[] }[];
};

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
    let tablesForSubGroup = subMap.get(subGroup);
    if (!tablesForSubGroup) {
      tablesForSubGroup = [];
      subMap.set(subGroup, tablesForSubGroup);
    }
    tablesForSubGroup.push(table);
  }
  return Array.from(groupMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([groupKey, subMap]) => ({
      groupLabel: groupKey || null,
      subGroups: Array.from(subMap.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([subKey, subTables]) => ({
          subGroupLabel: subMap.size > 1 ? subKey || null : null,
          tables: subTables.sort((a, b) => a.displayName.localeCompare(b.displayName)),
        })),
    }));
}

// ── Table label with capability & warning icons ──

function TableLabel({ table }: { table: TablePreview }) {
  return (
    <Group gap={6} wrap="nowrap" align="center">
      <Text13Regular c={table.disabled ? 'dimmed' : undefined}>{table.displayName}</Text13Regular>
      <CapabilityIcons
        disabledCreates={table.disabledCreates}
        disabledUpdates={table.disabledUpdates}
        disabledDeletes={table.disabledDeletes}
        size={14}
      />
      {table.disabled && table.disabledReason && (
        <Tooltip label={table.disabledReason} multiline maw={300}>
          <span style={{ display: 'inline-flex' }}>
            <StyledLucideIcon Icon={AlertTriangleIcon} size={14} c="var(--mantine-color-orange-5)" />
          </span>
        </Tooltip>
      )}
      {table.infoNote && (
        <Tooltip label={table.infoNote} multiline maw={300}>
          <span style={{ display: 'inline-flex' }}>
            <StyledLucideIcon Icon={InfoIcon} size={14} c="dimmed" />
          </span>
        </Tooltip>
      )}
    </Group>
  );
}

interface ChooseTablesModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: string;
  connectorAccount: ConnectorAccount;
  invalidateWorkspaceLevelData?: () => void;
  /**
   * Called after a successful save that enqueued one or more pull jobs — i.e. the
   * "Pull files" switch was on and at least one new table was created. Lets the
   * parent surface pull/download progress (the desktop pull-in-progress modal)
   * instead of leaving the pull to run silently in the background (DEV-10421).
   */
  onPullJobsStarted?: () => void;
}

export function ChooseTablesModal({
  opened,
  onClose,
  workbookId,
  connectorAccount,
  invalidateWorkspaceLevelData,
  onPullJobsStarted,
}: ChooseTablesModalProps) {
  const { data, isLoading, isValidating } = useSWR<TableList>(
    opened ? ['connector-tables', workbookId, connectorAccount.id] : null,
    () => scratchApiClient.connectorAccounts.listTables(workbookId, connectorAccount.id),
    { revalidateOnFocus: false, revalidateOnReconnect: false },
  );
  const discoveryMode = data?.discoveryMode ?? TableDiscoveryMode.LIST;
  const isSearchMode = discoveryMode === TableDiscoveryMode.SEARCH;
  const availableTables = useMemo(() => data?.tables || [], [data?.tables]);
  const tablesLoading = isLoading || (isValidating && availableTables.length === 0);

  const supportsFilter = data?.supportsFilters ?? false;
  const supportsFieldSelection = data?.supportsFieldSelection ?? false;
  const advancedSettings = useMemo(() => data?.advancedSettings ?? [], [data?.advancedSettings]);

  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedSearchTerm] = useDebouncedValue(searchTerm, 300);

  const { data: searchData, isLoading: searchLoading } = useSWR<TableSearchResult>(
    opened && isSearchMode && debouncedSearchTerm
      ? ['connector-tables-search', workbookId, connectorAccount.id, debouncedSearchTerm]
      : null,
    () => scratchApiClient.connectorAccounts.searchTables(workbookId, connectorAccount.id, debouncedSearchTerm),
    { revalidateOnFocus: false, revalidateOnReconnect: false, keepPreviousData: true },
  );

  const { dataFolderGroups, refresh: refreshFolders } = useDataFolders(workbookId);

  const [step, setStep] = useState<1 | 2>(1);
  const [selectedTableIds, setSelectedTableIds] = useState<Set<string>>(new Set());
  const [selectedTableMap, setSelectedTableMap] = useState<Map<string, TablePreview>>(new Map());
  const [filterValues, setFilterValues] = useState<Map<string, string>>(new Map());
  const [isSaving, setIsSaving] = useState(false);
  const [readOnlyValues, setReadOnlyValues] = useState<Map<string, boolean>>(new Map());
  const [fieldSelections, setFieldSelections] = useState<Map<string, { idField: string; nameField: string[] | null }>>(
    new Map(),
  );
  const [loadedTableSchemas, setLoadedTableSchemas] = useState<Map<string, TableSchemaPreview>>(new Map());
  const [schemasLoading, setSchemasLoading] = useState<Set<string>>(new Set());
  const [connectorOptions, setConnectorOptions] = useState<Map<string, Record<string, unknown>>>(new Map());
  const [triggerPull, setTriggerPull] = useState(true);
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [dirtyFileCount, setDirtyFileCount] = useState(0);
  const [saveErrors, setSaveErrors] = useState<{ name: string; error: string }[]>([]);
  const [successCount, setSuccessCount] = useState(0);

  const groupedTables = useMemo(() => groupTables(availableTables), [availableTables]);

  // Currently linked folders for this connector account
  const linkedFolders = useMemo(() => {
    const folders: {
      id: string;
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

  const linkedTablePreviews: TablePreview[] = useMemo(
    () =>
      linkedFolders.map((folder) => ({
        id: { wsId: folder.name, remoteId: folder.tableId },
        displayName: folder.name,
      })),
    [linkedFolders],
  );

  const searchResultTables: TablePreview[] = useMemo(() => searchData?.tables ?? [], [searchData]);

  const disabledTableKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const table of availableTables) {
      if (table.disabled) keys.add(table.id.remoteId.join('/'));
    }
    return keys;
  }, [availableTables]);

  // Initialize state when modal opens
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
        if (!disabledTableKeys.has(key)) linked.add(key);
        const folderFilter = (folder.options as DataFolderOptions)?.filter;
        if (folderFilter) initialFilters.set(key, folderFilter);
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
    setConnectorOptions(new Map());
    setSaveErrors([]);
    setSuccessCount(0);
    setShowConfirmation(false);
    setDirtyFileCount(0);
    setStep(1);

    const initialReadOnly = new Map<string, boolean>();
    linkedFolders.forEach((folder) => {
      if (folder.tableId.length > 0) {
        const key = folder.tableId.join('/');
        const opts = (folder.options ?? {}) as DataFolderOptions;
        initialReadOnly.set(key, Boolean(opts.readOnly));
      }
    });
    setReadOnlyValues(initialReadOnly);
  }, [opened, linkedFolders, linkedTablePreviews, disabledTableKeys]);

  const handleToggleTable = (table: TablePreview) => {
    if (table.disabled) return;
    const tableKey = table.id.remoteId.join('/');
    setSelectedTableIds((prev) => {
      const next = new Set(prev);
      if (next.has(tableKey)) next.delete(tableKey);
      else next.add(tableKey);
      return next;
    });
    setSelectedTableMap((prev) => {
      const next = new Map(prev);
      if (next.has(tableKey)) next.delete(tableKey);
      else next.set(tableKey, table);
      return next;
    });
  };

  const handleSelectAll = useCallback((tables: TablePreview[]) => {
    const enabled = tables.filter((t) => !t.disabled);
    setSelectedTableIds((prev) => {
      const next = new Set(prev);
      enabled.forEach((t) => next.add(t.id.remoteId.join('/')));
      return next;
    });
    setSelectedTableMap((prev) => {
      const next = new Map(prev);
      enabled.forEach((t) => next.set(t.id.remoteId.join('/'), t));
      return next;
    });
  }, []);

  const handleDeselectAll = useCallback((tables: TablePreview[]) => {
    const enabled = tables.filter((t) => !t.disabled);
    setSelectedTableIds((prev) => {
      const next = new Set(prev);
      enabled.forEach((t) => next.delete(t.id.remoteId.join('/')));
      return next;
    });
    setSelectedTableMap((prev) => {
      const next = new Map(prev);
      enabled.forEach((t) => next.delete(t.id.remoteId.join('/')));
      return next;
    });
  }, []);

  const currentlyLinkedKeys = useMemo(() => new Set(linkedFolders.map((f) => f.tableId.join('/'))), [linkedFolders]);

  const allKnownTables = useMemo(() => {
    if (!isSearchMode) return availableTables;
    const map = new Map<string, TablePreview>();
    for (const t of linkedTablePreviews) map.set(t.id.remoteId.join('/'), t);
    for (const t of searchResultTables) map.set(t.id.remoteId.join('/'), t);
    selectedTableMap.forEach((t, key) => map.set(key, t));
    return Array.from(map.values());
  }, [isSearchMode, linkedTablePreviews, searchResultTables, selectedTableMap, availableTables]);

  const tableLookup = useMemo(() => {
    const map = new Map<string, TablePreview>();
    for (const t of allKnownTables) map.set(t.id.remoteId.join('/'), t);
    return map;
  }, [allKnownTables]);

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

  const pendingFoldersToRemove = useMemo(
    () => linkedFolders.filter((folder) => !selectedTableIds.has(folder.tableId.join('/'))),
    [linkedFolders, selectedTableIds],
  );

  // Fetch schemas for step 2
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
          setFieldSelections((prev) => {
            if (prev.has(tableKey)) return prev;
            const next = new Map(prev);
            // titlePath / idPath are lodash dot paths (DEV-10092). Fall back to the
            // legacy names from a server predating the rename; nameField is a segment
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
        .catch((error) => console.debug('Failed to fetch table schema', tableKey, error))
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

  const selectedTablesForStep2 = useMemo(() => {
    const tables: {
      tableKey: string;
      displayName: string;
      isNew: boolean;
      isRemoved: boolean;
      isFullyLocked: boolean;
    }[] = [];
    const seen = new Set<string>();

    linkedFolders.forEach((folder) => {
      const key = folder.tableId.join('/');
      if (seen.has(key)) return;
      seen.add(key);
      tables.push({
        tableKey: key,
        displayName: folder.name,
        isNew: false,
        isRemoved: !selectedTableIds.has(key),
        isFullyLocked: isTableFullyLocked(tableLookup.get(key)),
      });
    });

    tablesToAdd.forEach((table) => {
      const key = table.id.remoteId.join('/');
      if (seen.has(key)) return;
      seen.add(key);
      tables.push({
        tableKey: key,
        displayName: table.displayName,
        isNew: true,
        isRemoved: false,
        isFullyLocked: isTableFullyLocked(table),
      });
    });

    return tables;
  }, [linkedFolders, selectedTableIds, tablesToAdd, tableLookup]);

  const handleSave = async () => {
    // If there are folders to remove, check for dirty files and show confirmation
    if (pendingFoldersToRemove.length > 0 && !showConfirmation) {
      try {
        const dirtyFiles = await scratchApiClient.dataFolders.getDirtyFiles(workbookId);
        const folderPaths = new Set(pendingFoldersToRemove.map((f) => (f.path ?? f.name).replace(/^\//, '')));
        const dirtyInRemovedFolders = dirtyFiles.filter((file) =>
          Array.from(folderPaths).some((folderPath) => {
            const prefix = folderPath.endsWith('/') ? folderPath : `${folderPath}/`;
            return file.path.startsWith(prefix);
          }),
        );
        if (dirtyInRemovedFolders.length > 0) {
          setDirtyFileCount(dirtyInRemovedFolders.length);
          setShowConfirmation(true);
          return;
        }
      } catch (error) {
        console.debug('Failed to check dirty files:', error);
      }
    }

    setIsSaving(true);
    setSaveErrors([]);
    setSuccessCount(0);

    const errors: { name: string; error: string }[] = [];
    let succeeded = 0;

    try {
      // Add new tables
      for (const table of tablesToAdd) {
        const tableKey = table.id.remoteId.join('/');
        const filter = filterValues.get(tableKey)?.trim() || undefined;
        const fields = fieldSelections.get(tableKey);
        const readOnly = readOnlyValues.get(tableKey) ?? false;
        const extraOpts = connectorOptions.get(tableKey) ?? {};
        const options: Record<string, unknown> = { ...extraOpts };
        if (isTableFullyLocked(table) || readOnly) options.readOnly = true;

        try {
          // GENERIC_API: probe the endpoint before persisting so the connector
          // has pagination strategy, idPath, and inferred schema for pulls.
          if (connectorAccount.service === 'GENERIC_API') {
            try {
              const probeResult = await scratchApiClient.generic.probeEndpoint(
                workbookId,
                connectorAccount.id,
                table.id.wsId,
              );
              options.genericApi = { endpointId: table.id.wsId, probe: probeResult.probe };
            } catch (probeErr) {
              const axiosData = (probeErr as { response?: { data?: { message?: unknown } } })?.response?.data;
              const msg =
                typeof axiosData?.message === 'string'
                  ? axiosData.message
                  : probeErr instanceof Error
                    ? probeErr.message
                    : 'Probe failed.';
              errors.push({ name: table.displayName, error: `Probe failed: ${msg}` });
              console.debug(`Probe failed for ${table.displayName}:`, probeErr);
              continue;
            }
          }

          const createDto = {
            tableId: table.id.remoteId,
            workbookId: workbookId as WorkbookId,
            name: table.displayName,
            connectorAccountId: connectorAccount.id,
            filter,
            idFieldOverride: fields?.idField || undefined,
            nameFieldOverride: fields?.nameField || undefined,
            options: Object.keys(options).length > 0 ? options : undefined,
            triggerPull,
          };
          await scratchApiClient.dataFolders.create(createDto);
          succeeded++;
        } catch (err) {
          const axiosData = (err as { response?: { data?: { message?: unknown } } })?.response?.data;
          const serverMsg = axiosData?.message;
          const msg = serverMsg
            ? typeof serverMsg === 'string'
              ? serverMsg
              : JSON.stringify(serverMsg)
            : err instanceof Error
              ? err.message
              : 'Unknown error';
          errors.push({ name: table.displayName, error: msg });
          console.debug(`Failed to add table ${table.displayName}:`, err);
          console.debug('Server response data:', axiosData);
        }
      }

      // Update existing tables with changed filters/options
      for (const folder of linkedFolders) {
        const folderKey = folder.tableId.join('/');
        if (!selectedTableIds.has(folderKey)) continue;
        const newFilter = filterValues.get(folderKey)?.trim() || null;
        const existingFilter = (folder.options as DataFolderOptions)?.filter || null;
        const currentReadOnly = readOnlyValues.get(folderKey) ?? false;
        const existingReadOnly = Boolean((folder.options as DataFolderOptions)?.readOnly);
        if (newFilter !== existingFilter || currentReadOnly !== existingReadOnly) {
          const opts: Record<string, unknown> = { ...(folder.options ?? {}) };
          if (currentReadOnly || isTableFullyLocked(tableLookup.get(folderKey))) {
            opts.readOnly = true;
          } else {
            delete opts.readOnly;
          }
          await scratchApiClient.dataFolders.update(folder.id, { filter: newFilter, options: opts });
        }
      }

      // Remove unselected tables
      for (const folder of pendingFoldersToRemove) {
        await scratchApiClient.dataFolders.delete(folder.id);
      }

      await refreshFolders();

      if (errors.length > 0) {
        setSaveErrors(errors);
        setSuccessCount(succeeded);
        invalidateWorkspaceLevelData?.();
      } else if (triggerPull && succeeded > 0) {
        // A clean save with the "Pull files" switch on enqueues a pull job per
        // newly created folder. Hand off to the parent's pull-in-progress modal,
        // which owns the pull → download → refresh lifecycle. We deliberately do
        // NOT call invalidateWorkspaceLevelData here: that would kick off a
        // second, premature local pull that races the modal before the jobs
        // (and the new connection's server-side repo) are ready.
        onPullJobsStarted?.();
        onClose();
      } else {
        invalidateWorkspaceLevelData?.();
        onClose();
      }
    } catch (error) {
      console.debug('Failed to update tables:', error);
    } finally {
      setIsSaving(false);
    }
  };

  const enabledTables = useMemo(() => availableTables.filter((t) => !t.disabled), [availableTables]);
  const allEnabledSelected = useMemo(
    () => enabledTables.length > 0 && enabledTables.every((t) => selectedTableIds.has(t.id.remoteId.join('/'))),
    [enabledTables, selectedTableIds],
  );

  const connectionName = connectorAccount.displayName;

  const connectorTitle = (
    <Group gap="xs" align="center">
      <ConnectorIcon connector={connectorAccount.service} size={20} p={0} />
      <Text fw={600}>{connectionName}</Text>
    </Group>
  );

  // Step 1: LIST mode
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
        <Text13Regular c="dimmed" ta="center" py="xl" px="lg">
          {data?.tableSearchInstructions ?? 'No tables available for this connection'}
        </Text13Regular>
      ) : (
        <ScrollArea.Autosize mah={400}>
          <Stack gap="xs">
            {groupedTables
              ? groupedTables.map((group, gi) => {
                  const groupEnabled = group.subGroups.flatMap((sg) => sg.tables.filter((t) => !t.disabled));
                  const allGroupSel =
                    groupEnabled.length > 0 && groupEnabled.every((t) => selectedTableIds.has(t.id.remoteId.join('/')));
                  return (
                    <Box key={group.groupLabel ?? gi}>
                      {group.groupLabel && (
                        <Group gap="xs" align="center" mb={4} mt={gi > 0 ? 'sm' : 0}>
                          <Text13Medium>{group.groupLabel}</Text13Medium>
                          {groupEnabled.length > 1 && (
                            <ButtonSecondaryInline
                              onClick={() =>
                                allGroupSel ? handleDeselectAll(groupEnabled) : handleSelectAll(groupEnabled)
                              }
                            >
                              {allGroupSel ? 'Deselect all' : 'Select all'}
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
                            {sg.tables.map((table) => (
                              <Checkbox
                                key={table.id.remoteId.join('/')}
                                label={
                                  <Text13Regular c={table.disabled ? 'dimmed' : undefined}>
                                    {table.displayName}
                                  </Text13Regular>
                                }
                                checked={selectedTableIds.has(table.id.remoteId.join('/'))}
                                disabled={table.disabled}
                                onChange={() => handleToggleTable(table)}
                              />
                            ))}
                          </Stack>
                        </Box>
                      ))}
                    </Box>
                  );
                })
              : availableTables.map((table) => (
                  <Checkbox
                    key={table.id.remoteId.join('/')}
                    label={<TableLabel table={table} />}
                    checked={selectedTableIds.has(table.id.remoteId.join('/'))}
                    disabled={table.disabled}
                    onChange={() => handleToggleTable(table)}
                  />
                ))}
          </Stack>
        </ScrollArea.Autosize>
      )}

      <Group justify="flex-end" gap="sm" mt="md">
        <ButtonSecondaryOutline onClick={onClose}>Cancel</ButtonSecondaryOutline>
        <ButtonPrimaryLight
          onClick={() => setStep(2)}
          disabled={selectedTableIds.size === 0 && pendingFoldersToRemove.length === 0}
        >
          Next
        </ButtonPrimaryLight>
      </Group>
    </Stack>
  );

  // Step 1: SEARCH mode
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
              {linkedTablePreviews.map((table) => (
                <Checkbox
                  key={table.id.remoteId.join('/')}
                  label={<TableLabel table={table} />}
                  checked={selectedTableIds.has(table.id.remoteId.join('/'))}
                  onChange={() => handleToggleTable(table)}
                />
              ))}
            </Stack>
          )}

          <TextInput
            placeholder={data?.tableSearchPlaceholder ?? 'Search for databases...'}
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
            <ScrollArea.Autosize mah={300}>
              <Stack gap="xs">
                {searchResultTables.map((table) => (
                  <Checkbox
                    key={table.id.remoteId.join('/')}
                    label={<TableLabel table={table} />}
                    checked={selectedTableIds.has(table.id.remoteId.join('/'))}
                    disabled={table.disabled}
                    onChange={() => handleToggleTable(table)}
                  />
                ))}
              </Stack>
            </ScrollArea.Autosize>
          ) : debouncedSearchTerm ? (
            <Text13Regular c="dimmed" ta="center" py="md">
              No databases found
            </Text13Regular>
          ) : availableTables.length > 0 ? (
            <ScrollArea.Autosize mah={300}>
              <Stack gap="xs">
                {availableTables.map((table) => (
                  <Checkbox
                    key={table.id.remoteId.join('/')}
                    label={<TableLabel table={table} />}
                    checked={selectedTableIds.has(table.id.remoteId.join('/'))}
                    disabled={table.disabled}
                    onChange={() => handleToggleTable(table)}
                  />
                ))}
              </Stack>
            </ScrollArea.Autosize>
          ) : (
            <Text13Regular c="dimmed" ta="center" py="md" px="lg">
              {data?.tableSearchInstructions ?? 'Type to search for databases'}
            </Text13Regular>
          )}
        </>
      )}

      <Group justify="flex-end" gap="sm" mt="md">
        <ButtonSecondaryOutline onClick={onClose}>Cancel</ButtonSecondaryOutline>
        <ButtonPrimaryLight
          onClick={() => setStep(2)}
          disabled={selectedTableIds.size === 0 && pendingFoldersToRemove.length === 0}
        >
          Next
        </ButtonPrimaryLight>
      </Group>
    </Stack>
  );

  // Step 2: Configure
  const renderStep2 = () => (
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
            const schemaFields = tableSchema ? flattenSchemaFields(tableSchema.schema) : [];

            return (
              <Box key={entry.tableKey}>
                {index > 0 && <Divider mb="sm" />}
                <Stack gap="xs">
                  <Group gap="xs" align="center">
                    <Text13Medium c={entry.isRemoved ? 'dimmed' : undefined}>{entry.displayName}</Text13Medium>
                    {entry.isRemoved && <Badge color="red">Will be removed</Badge>}
                    {entry.isNew && <Badge color="green">New</Badge>}
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
                            onChange={(e) => {
                              const val = e.currentTarget.checked;
                              setReadOnlyValues((prev) => new Map(prev).set(entry.tableKey, val));
                            }}
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

                  {showFieldSelectors &&
                    tableSchema &&
                    (() => {
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
                              setFieldSelections((prev) => {
                                const next = new Map(prev);
                                const current = next.get(entry.tableKey) ?? { idField: '', nameField: null };
                                next.set(entry.tableKey, {
                                  ...current,
                                  idField: picked ? picked.path.join('.') : '',
                                });
                                return next;
                              });
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
                              setFieldSelections((prev) => {
                                const next = new Map(prev);
                                const current = next.get(entry.tableKey) ?? { idField: '', nameField: null };
                                next.set(entry.tableKey, {
                                  ...current,
                                  nameField: picked ? picked.path : null,
                                });
                                return next;
                              });
                            }}
                            placeholder="None (use ID for filenames)"
                            clearable
                            size="xs"
                            searchable
                          />
                        </>
                      );
                    })()}

                  {!entry.isRemoved && supportsFilter && (
                    <Textarea
                      label="Filter (optional)"
                      description="Leave blank to pull all records, or enter a filter expression."
                      placeholder="Enter filter expression..."
                      value={filterValues.get(entry.tableKey) ?? ''}
                      onChange={(e) => {
                        const val = e.currentTarget.value;
                        setFilterValues((prev) => {
                          const next = new Map(prev);
                          if (val) next.set(entry.tableKey, val);
                          else next.delete(entry.tableKey);
                          return next;
                        });
                      }}
                      autosize
                      minRows={2}
                      maxRows={4}
                    />
                  )}

                  {!entry.isRemoved &&
                    advancedSettings
                      .filter((setting) => settingAppliesToTable(setting, tableLookup.get(entry.tableKey)?.id.wsId))
                      .map((setting) => {
                        const fieldNames = schemaFields.map((f) => f.path.join('.'));
                        return (
                          <ConnectorSettingField
                            key={setting.key}
                            setting={setting}
                            value={connectorOptions.get(entry.tableKey)?.[setting.key]}
                            onChange={(val) => {
                              setConnectorOptions((prev) => {
                                const next = new Map(prev);
                                const current = next.get(entry.tableKey) ?? {};
                                next.set(entry.tableKey, { ...current, [setting.key]: val });
                                return next;
                              });
                            }}
                            fieldOptions={fieldNames}
                          />
                        );
                      })}
                </Stack>
              </Box>
            );
          })}
        </Stack>
      </ScrollArea.Autosize>

      {tablesToAdd.length > 0 && (
        <Switch
          label="Pull files"
          description="Immediately start pulling files for the new tables after saving."
          checked={triggerPull}
          onChange={(e) => setTriggerPull(e.currentTarget.checked)}
          size="sm"
        />
      )}

      {saveErrors.length > 0 && (
        <Alert color="red" variant="light" icon={<AlertTriangleIcon size={16} />}>
          <Text size="sm" fw={500}>
            {saveErrors.length} table{saveErrors.length === 1 ? '' : 's'} failed to add:
          </Text>
          <List size="sm" mt="xs">
            {saveErrors.map((e) => (
              <List.Item key={e.name}>
                <Text size="sm" span fw={500}>
                  {e.name}:
                </Text>{' '}
                {e.error}
              </List.Item>
            ))}
          </List>
        </Alert>
      )}

      <Group justify="flex-end" gap="sm" mt="md">
        {saveErrors.length > 0 ? (
          <>
            <ButtonSecondaryOutline onClick={onClose}>Close</ButtonSecondaryOutline>
            {successCount > 0 && (
              <ButtonPrimaryLight onClick={onClose}>
                Done ({successCount} table{successCount === 1 ? '' : 's'} added)
              </ButtonPrimaryLight>
            )}
          </>
        ) : (
          <>
            <ButtonSecondaryOutline onClick={() => setStep(1)}>Back</ButtonSecondaryOutline>
            <ButtonPrimaryLight onClick={() => void handleSave()} loading={isSaving}>
              Save
            </ButtonPrimaryLight>
          </>
        )}
      </Group>
    </Stack>
  );

  const renderConfirmation = () => (
    <Stack gap="md">
      <Alert icon={<AlertTriangleIcon size={16} />} color="orange" variant="light">
        <Text size="sm">The following tables will be removed from this workspace:</Text>
        <List size="sm" mt="xs">
          {pendingFoldersToRemove.map((f) => (
            <List.Item key={f.id}>{f.name}</List.Item>
          ))}
        </List>
        {dirtyFileCount > 0 && (
          <Text size="sm" c="orange" mt="sm" fw={500}>
            There {dirtyFileCount === 1 ? 'is' : 'are'} {dirtyFileCount.toLocaleString()} file
            {dirtyFileCount === 1 ? '' : 's'} with unpublished changes that will be discarded.
          </Text>
        )}
      </Alert>
      <Group justify="flex-end" gap="sm">
        <ButtonSecondaryOutline
          onClick={() => {
            setShowConfirmation(false);
            setDirtyFileCount(0);
          }}
        >
          Back
        </ButtonSecondaryOutline>
        <ButtonPrimaryLight
          color="red"
          onClick={() => {
            setShowConfirmation(false);
            void handleSave();
          }}
          loading={isSaving}
        >
          Remove
        </ButtonPrimaryLight>
      </Group>
    </Stack>
  );

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={connectorTitle}
      size="lg"
      centered
      closeOnEscape={!isSaving}
      closeOnClickOutside={!isSaving}
    >
      {showConfirmation
        ? renderConfirmation()
        : step === 2
          ? renderStep2()
          : isSearchMode
            ? renderStep1Search()
            : renderStep1List()}
    </Modal>
  );
}
