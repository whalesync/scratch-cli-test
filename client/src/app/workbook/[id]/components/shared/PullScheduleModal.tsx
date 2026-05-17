'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text13Book } from '@/app/components/base/text';
import { ModalWrapper } from '@/app/components/ModalWrapper';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { useDataFolders } from '@/hooks/use-data-folders';
import { useDevTools } from '@/hooks/use-dev-tools';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { scheduleApi } from '@/lib/api/schedule';
import { isExperimentEnabled } from '@/types/server-entities/users';
import { Select, Stack } from '@mantine/core';
import type { DataFolder, Schedule } from '@spinner/shared-types';
import { ScheduleAction } from '@spinner/shared-types';
import { useEffect, useMemo, useState } from 'react';

interface PullScheduleModalProps {
  opened: boolean;
  onClose: () => void;
  folder: DataFolder;
}

const MANUAL_ONLY = '';
const EVERY_MINUTE = '* * * * *';

const PULL_SCHEDULE_OPTIONS = [
  { value: MANUAL_ONLY, label: 'Manual only' },
  { value: '*/5 * * * *', label: 'Every 5 minutes' },
  { value: '*/30 * * * *', label: 'Every 30 minutes' },
  { value: '0 * * * *', label: 'Hourly' },
  { value: '0 0 * * *', label: 'Daily' },
];

const DEV_ONLY_OPTION = { value: EVERY_MINUTE, label: 'Every minute (internal use only)' };

export function PullScheduleModal({ opened, onClose, folder }: PullScheduleModalProps) {
  const { refresh: refreshDataFolders } = useDataFolders();
  const { isDevToolsEnabled } = useDevTools();
  const { metadata } = useConnectorsMetadata();
  const { user } = useScratchPadUser();
  const [loading, setLoading] = useState(false);
  const [fullValue, setFullValue] = useState<string>(MANUAL_ONLY);
  const [incrementalValue, setIncrementalValue] = useState<string>(MANUAL_ONLY);

  const supportsIncrementalPull =
    isExperimentEnabled('INCREMENTAL_POLLING_ENABLED', user) && folder.connectorService
      ? Boolean(metadata?.[folder.connectorService]?.incrementalPull)
      : false;

  const scheduleOptions = useMemo(
    () => (isDevToolsEnabled ? [...PULL_SCHEDULE_OPTIONS, DEV_ONLY_OPTION] : PULL_SCHEDULE_OPTIONS),
    [isDevToolsEnabled],
  );

  // A legacy `PULL` row is treated as the folder's full-pull schedule. We
  // update/delete it in place (never create a duplicate FULL_PULL alongside
  // it); converting PULL → FULL_PULL is handled by a separate migration.
  const existingFull = useMemo(
    () =>
      folder.schedules.find((s) => s.action === ScheduleAction.FULL_PULL) ??
      folder.schedules.find((s) => s.action === ScheduleAction.PULL) ??
      null,
    [folder.schedules],
  );
  const existingIncremental = useMemo(
    () => folder.schedules.find((s) => s.action === ScheduleAction.INCREMENTAL_PULL) ?? null,
    [folder.schedules],
  );

  useEffect(() => {
    if (opened) {
      setFullValue(existingFull?.cronExpression ?? MANUAL_ONLY);
      setIncrementalValue(existingIncremental?.cronExpression ?? MANUAL_ONLY);
    }
  }, [opened, existingFull, existingIncremental]);

  const applyRow = async (
    existing: Schedule | null,
    value: string,
    action: ScheduleAction,
    name: string,
  ): Promise<void> => {
    if (value === MANUAL_ONLY) {
      if (existing) {
        await scheduleApi.delete(folder.workbookId, existing.id);
      }
      return;
    }
    if (existing) {
      if (existing.cronExpression !== value) {
        await scheduleApi.update(folder.workbookId, existing.id, { cronExpression: value });
      }
      return;
    }
    await scheduleApi.create(folder.workbookId, {
      name,
      action,
      entityId: folder.id,
      cronExpression: value,
    });
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      await applyRow(existingFull, fullValue, ScheduleAction.FULL_PULL, `Pull ${folder.name}`);
      if (supportsIncrementalPull) {
        await applyRow(
          existingIncremental,
          incrementalValue,
          ScheduleAction.INCREMENTAL_PULL,
          `Incremental pull ${folder.name}`,
        );
      }
      await refreshDataFolders();
      ScratchpadNotifications.success({
        title: 'Schedule Updated',
        message: `Pull schedule for ${folder.name} has been updated.`,
      });
      onClose();
    } catch (error) {
      console.debug('Failed to update pull schedule', error);
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
      title="Manage schedule"
      opened={opened}
      onClose={onClose}
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
        <Text13Book>
          Define how often Scratch automatically pulls data from {folder.connectorDisplayName} for this table.
        </Text13Book>
        <Select
          label="Full pull frequency"
          description="Full pulls scan every record and detect deletions."
          data={scheduleOptions}
          value={fullValue}
          onChange={(val) => setFullValue(val ?? MANUAL_ONLY)}
          disabled={loading}
          allowDeselect={false}
          renderOption={({ option }) =>
            option.value === EVERY_MINUTE ? (
              <span style={{ color: 'var(--mantine-color-violet-6)' }}>{option.label}</span>
            ) : (
              <span>{option.label}</span>
            )
          }
        />
        {supportsIncrementalPull && (
          <Select
            label="Incremental pull frequency"
            description="Incremental pulls fetch only records modified since the previous run (no deletions)."
            data={scheduleOptions}
            value={incrementalValue}
            onChange={(val) => setIncrementalValue(val ?? MANUAL_ONLY)}
            disabled={loading}
            allowDeselect={false}
            renderOption={({ option }) =>
              option.value === EVERY_MINUTE ? (
                <span style={{ color: 'var(--mantine-color-violet-6)' }}>{option.label}</span>
              ) : (
                <span>{option.label}</span>
              )
            }
          />
        )}
      </Stack>
    </ModalWrapper>
  );
}
