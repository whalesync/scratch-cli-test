'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text12Regular, Text13Book, Text13Medium } from '@/app/components/base/text';
import { ModalWrapper } from '@/app/components/ModalWrapper';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { useDataFolders } from '@/hooks/use-data-folders';
import { useDevTools } from '@/hooks/use-dev-tools';
import { useSchedules } from '@/hooks/use-schedules';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import type { ComboboxItem } from '@mantine/core';
import { Group, SegmentedControl, Select, Stack } from '@mantine/core';
import type { ConnectorAccount, DataFolder, Schedule, WorkbookId } from '@spinner/shared-types';
import { ScheduleAction } from '@spinner/shared-types';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  applyScheduleRow,
  DEV_ONLY_OPTION,
  EVERY_MINUTE,
  MANUAL_ONLY,
  PULL_SCHEDULE_OPTIONS,
} from './pull-schedule-helpers';

interface ConnectionPullScheduleModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
  connectorAccount: ConnectorAccount;
  /** The connection's tables (linked DataFolders), for the "each table" mode and metadata. */
  dataFolders: DataFolder[];
}

type ScheduleMode = 'connection' | 'tables';

/** A single frequency dropdown, with the dev-only "Every minute" option highlighted. */
function FrequencySelect(props: {
  label: string;
  description?: string;
  value: string;
  onChange: (value: string) => void;
  options: ComboboxItem[];
  disabled: boolean;
}) {
  const { label, description, value, onChange, options, disabled } = props;
  return (
    <Select
      label={label}
      description={description}
      data={options}
      value={value}
      onChange={(val) => onChange(val ?? MANUAL_ONLY)}
      disabled={disabled}
      allowDeselect={false}
      renderOption={({ option }) =>
        option.value === EVERY_MINUTE ? (
          <span style={{ color: 'var(--mantine-color-violet-6)' }}>{option.label}</span>
        ) : (
          <span>{option.label}</span>
        )
      }
    />
  );
}

/**
 * Connection-level pull schedule dialog (DEV-10396). A switch between two mutually
 * exclusive modes:
 *  - "Entire connection" — a single connection-wide schedule (CONNECTION_FULL_PULL /
 *    CONNECTION_INCREMENTAL_PULL) that fans out to every table in the connection.
 *  - "Each table" — one FULL_PULL / INCREMENTAL_PULL schedule per table.
 *
 * This is the only place pull schedules are managed; saving one mode clears the
 * other for this connection so the two never run at once.
 */
export function ConnectionPullScheduleModal({
  opened,
  onClose,
  workbookId,
  connectorAccount,
  dataFolders,
}: ConnectionPullScheduleModalProps) {
  const { schedules, isLoading, refresh: refreshSchedules } = useSchedules(opened ? workbookId : null);
  const { refresh: refreshDataFolders } = useDataFolders();
  const { isDevToolsEnabled } = useDevTools();
  const { metadata } = useConnectorsMetadata();

  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<ScheduleMode>('connection');
  const [connectionFullValue, setConnectionFullValue] = useState<string>(MANUAL_ONLY);
  const [connectionIncrementalValue, setConnectionIncrementalValue] = useState<string>(MANUAL_ONLY);
  const [tableFullValueByFolderId, setTableFullValueByFolderId] = useState<Record<string, string>>({});
  const [tableIncrementalValueByFolderId, setTableIncrementalValueByFolderId] = useState<Record<string, string>>({});

  const supportsIncrementalPull = Boolean(metadata?.[connectorAccount.service]?.incrementalPull);

  const scheduleOptions = useMemo<ComboboxItem[]>(
    () => (isDevToolsEnabled ? [...PULL_SCHEDULE_OPTIONS, DEV_ONLY_OPTION] : PULL_SCHEDULE_OPTIONS),
    [isDevToolsEnabled],
  );

  const folderIdSet = useMemo<Set<string>>(() => new Set(dataFolders.map((folder) => folder.id)), [dataFolders]);

  // --- Existing schedules, derived from the workbook's schedule list ---

  const existingConnectionFull = useMemo(
    () =>
      schedules.find((s) => s.entityId === connectorAccount.id && s.action === ScheduleAction.CONNECTION_FULL_PULL) ??
      null,
    [schedules, connectorAccount.id],
  );
  const existingConnectionIncremental = useMemo(
    () =>
      schedules.find(
        (s) => s.entityId === connectorAccount.id && s.action === ScheduleAction.CONNECTION_INCREMENTAL_PULL,
      ) ?? null,
    [schedules, connectorAccount.id],
  );

  // A legacy `PULL` row counts as the table's full-pull schedule (see PullScheduleModal).
  const existingTableFullByFolderId = useMemo(() => {
    const map = new Map<string, Schedule>();
    for (const folder of dataFolders) {
      const full =
        schedules.find((s) => s.entityId === folder.id && s.action === ScheduleAction.FULL_PULL) ??
        schedules.find((s) => s.entityId === folder.id && s.action === ScheduleAction.PULL);
      if (full) {
        map.set(folder.id, full);
      }
    }
    return map;
  }, [schedules, dataFolders]);
  const existingTableIncrementalByFolderId = useMemo(() => {
    const map = new Map<string, Schedule>();
    for (const folder of dataFolders) {
      const incremental = schedules.find(
        (s) => s.entityId === folder.id && s.action === ScheduleAction.INCREMENTAL_PULL,
      );
      if (incremental) {
        map.set(folder.id, incremental);
      }
    }
    return map;
  }, [schedules, dataFolders]);

  // Initialize the form to the persisted state exactly once per open, after the
  // workbook's schedules have loaded. We must NOT re-run this on every render: the
  // parent passes a fresh `dataFolders` array reference each render, and this effect
  // sets new object references — together that would loop ("Maximum update depth
  // exceeded"). The ref guard makes initialization edge-triggered on open.
  const hasInitializedRef = useRef(false);
  useEffect(() => {
    if (!opened) {
      hasInitializedRef.current = false;
      return;
    }
    if (hasInitializedRef.current || isLoading) {
      return;
    }
    hasInitializedRef.current = true;

    const connectionFull =
      schedules.find((s) => s.entityId === connectorAccount.id && s.action === ScheduleAction.CONNECTION_FULL_PULL) ??
      null;
    const connectionIncremental =
      schedules.find(
        (s) => s.entityId === connectorAccount.id && s.action === ScheduleAction.CONNECTION_INCREMENTAL_PULL,
      ) ?? null;
    setConnectionFullValue(connectionFull?.cronExpression ?? MANUAL_ONLY);
    setConnectionIncrementalValue(connectionIncremental?.cronExpression ?? MANUAL_ONLY);

    const fullByFolderId: Record<string, string> = {};
    const incrementalByFolderId: Record<string, string> = {};
    let anyTableSchedule = false;
    for (const folder of dataFolders) {
      // A legacy `PULL` row counts as the table's full-pull schedule.
      const tableFull =
        schedules.find((s) => s.entityId === folder.id && s.action === ScheduleAction.FULL_PULL) ??
        schedules.find((s) => s.entityId === folder.id && s.action === ScheduleAction.PULL);
      const tableIncremental = schedules.find(
        (s) => s.entityId === folder.id && s.action === ScheduleAction.INCREMENTAL_PULL,
      );
      fullByFolderId[folder.id] = tableFull?.cronExpression ?? MANUAL_ONLY;
      incrementalByFolderId[folder.id] = tableIncremental?.cronExpression ?? MANUAL_ONLY;
      if (tableFull || tableIncremental) {
        anyTableSchedule = true;
      }
    }
    setTableFullValueByFolderId(fullByFolderId);
    setTableIncrementalValueByFolderId(incrementalByFolderId);

    // Default to whichever mode currently holds a schedule; fall back to "entire
    // connection" (the headline option) for a connection with nothing configured.
    const hasConnectionSchedule = Boolean(connectionFull || connectionIncremental);
    setMode(hasConnectionSchedule ? 'connection' : anyTableSchedule ? 'tables' : 'connection');
  }, [opened, isLoading, schedules, dataFolders, connectorAccount.id]);

  const deletePerTablePullSchedules = async (): Promise<void> => {
    const perTablePullSchedules = schedules.filter(
      (s) =>
        folderIdSet.has(s.entityId) &&
        (s.action === ScheduleAction.FULL_PULL ||
          s.action === ScheduleAction.INCREMENTAL_PULL ||
          s.action === ScheduleAction.PULL),
    );
    await Promise.all(perTablePullSchedules.map((s) => scratchApiClient.schedule.delete(workbookId, s.id)));
  };

  const deleteConnectionPullSchedules = async (): Promise<void> => {
    const connectionSchedules = schedules.filter(
      (s) =>
        s.entityId === connectorAccount.id &&
        (s.action === ScheduleAction.CONNECTION_FULL_PULL || s.action === ScheduleAction.CONNECTION_INCREMENTAL_PULL),
    );
    await Promise.all(connectionSchedules.map((s) => scratchApiClient.schedule.delete(workbookId, s.id)));
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      if (mode === 'connection') {
        await applyScheduleRow({
          workbookId,
          existing: existingConnectionFull,
          value: connectionFullValue,
          action: ScheduleAction.CONNECTION_FULL_PULL,
          entityId: connectorAccount.id,
          name: `Pull ${connectorAccount.displayName}`,
        });
        if (supportsIncrementalPull) {
          await applyScheduleRow({
            workbookId,
            existing: existingConnectionIncremental,
            value: connectionIncrementalValue,
            action: ScheduleAction.CONNECTION_INCREMENTAL_PULL,
            entityId: connectorAccount.id,
            name: `Incremental pull ${connectorAccount.displayName}`,
          });
        }
        // A connection-wide schedule replaces any per-table pull schedules.
        await deletePerTablePullSchedules();
      } else {
        for (const folder of dataFolders) {
          await applyScheduleRow({
            workbookId,
            existing: existingTableFullByFolderId.get(folder.id) ?? null,
            value: tableFullValueByFolderId[folder.id] ?? MANUAL_ONLY,
            action: ScheduleAction.FULL_PULL,
            entityId: folder.id,
            name: `Pull ${folder.name}`,
          });
          if (supportsIncrementalPull) {
            await applyScheduleRow({
              workbookId,
              existing: existingTableIncrementalByFolderId.get(folder.id) ?? null,
              value: tableIncrementalValueByFolderId[folder.id] ?? MANUAL_ONLY,
              action: ScheduleAction.INCREMENTAL_PULL,
              entityId: folder.id,
              name: `Incremental pull ${folder.name}`,
            });
          }
        }
        // Per-table schedules replace the connection-wide schedule.
        await deleteConnectionPullSchedules();
      }

      await Promise.all([refreshSchedules(), refreshDataFolders()]);
      ScratchpadNotifications.success({
        title: 'Schedule Updated',
        message: `Pull schedule for ${connectorAccount.displayName} has been updated.`,
      });
      onClose();
    } catch (error) {
      console.debug('Failed to update connection pull schedule', error);
      ScratchpadNotifications.error({
        title: 'Schedule Error',
        message: 'Could not update the pull schedule.',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalWrapper
      title="Manage pull schedule"
      opened={opened}
      onClose={onClose}
      size="xl"
      customProps={{
        footer: (
          <>
            <ButtonSecondaryOutline onClick={onClose}>Cancel</ButtonSecondaryOutline>
            <ButtonPrimaryLight onClick={handleSave} loading={loading}>
              Save
            </ButtonPrimaryLight>
          </>
        ),
      }}
    >
      <Stack>
        <Text13Book>Define how often Scratch automatically pulls data from {connectorAccount.displayName}.</Text13Book>

        <SegmentedControl
          fullWidth
          value={mode}
          onChange={(value) => setMode(value as ScheduleMode)}
          disabled={loading}
          data={[
            { value: 'connection', label: 'Entire connection' },
            { value: 'tables', label: 'Each table' },
          ]}
        />

        {mode === 'connection' ? (
          <Stack>
            <Text12Regular c="var(--fg-secondary)">
              One schedule for the whole connection — covers every table, including ones you add later. Replaces any
              per-table pull schedules.
            </Text12Regular>
            <FrequencySelect
              label="Full pull frequency"
              description="Full pulls scan every record and detect deletions."
              value={connectionFullValue}
              onChange={setConnectionFullValue}
              options={scheduleOptions}
              disabled={loading}
            />
            {supportsIncrementalPull && (
              <FrequencySelect
                label="Incremental pull frequency"
                description="Incremental pulls fetch only records modified since the previous run (no deletions)."
                value={connectionIncrementalValue}
                onChange={setConnectionIncrementalValue}
                options={scheduleOptions}
                disabled={loading}
              />
            )}
          </Stack>
        ) : (
          <Stack>
            <Text12Regular c="var(--fg-secondary)">
              A separate schedule per table. Replaces the connection-wide schedule.
            </Text12Regular>
            {dataFolders.length === 0 ? (
              <Text12Regular c="var(--fg-secondary)">This connection has no tables yet.</Text12Regular>
            ) : (
              dataFolders.map((folder) => (
                <Stack key={folder.id} gap={6}>
                  <Text13Medium>{folder.name}</Text13Medium>
                  <Group grow align="flex-start" wrap="nowrap">
                    <FrequencySelect
                      label="Full pull"
                      value={tableFullValueByFolderId[folder.id] ?? MANUAL_ONLY}
                      onChange={(value) => setTableFullValueByFolderId((prev) => ({ ...prev, [folder.id]: value }))}
                      options={scheduleOptions}
                      disabled={loading}
                    />
                    {supportsIncrementalPull && (
                      <FrequencySelect
                        label="Incremental pull"
                        value={tableIncrementalValueByFolderId[folder.id] ?? MANUAL_ONLY}
                        onChange={(value) =>
                          setTableIncrementalValueByFolderId((prev) => ({ ...prev, [folder.id]: value }))
                        }
                        options={scheduleOptions}
                        disabled={loading}
                      />
                    )}
                  </Group>
                </Stack>
              ))
            )}
          </Stack>
        )}
      </Stack>
    </ModalWrapper>
  );
}
