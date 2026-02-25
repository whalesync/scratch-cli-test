'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text13Book } from '@/app/components/base/text';
import { ModalWrapper } from '@/app/components/ModalWrapper';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { useDataFolders } from '@/hooks/use-data-folders';
import { useDevTools } from '@/hooks/use-dev-tools';
import { scheduleApi } from '@/lib/api/schedule';
import { Select, Stack } from '@mantine/core';
import type { DataFolder } from '@spinner/shared-types';
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
  const [loading, setLoading] = useState(false);
  const [selectedValue, setSelectedValue] = useState<string>(MANUAL_ONLY);

  const scheduleOptions = useMemo(
    () => (isDevToolsEnabled ? [...PULL_SCHEDULE_OPTIONS, DEV_ONLY_OPTION] : PULL_SCHEDULE_OPTIONS),
    [isDevToolsEnabled],
  );

  const pullSchedule = useMemo(
    () => folder.schedules.find((s) => s.action === ScheduleAction.PULL) ?? null,
    [folder.schedules],
  );

  useEffect(() => {
    if (opened) {
      setSelectedValue(pullSchedule?.cronExpression ?? MANUAL_ONLY);
    }
  }, [opened, pullSchedule]);

  const handleSave = async () => {
    setLoading(true);
    try {
      if (selectedValue === MANUAL_ONLY) {
        // Delete existing schedule if switching to manual
        if (pullSchedule) {
          await scheduleApi.delete(folder.workbookId, pullSchedule.id);
        }
      } else if (pullSchedule) {
        await scheduleApi.update(folder.workbookId, pullSchedule.id, { cronExpression: selectedValue });
      } else {
        await scheduleApi.create(folder.workbookId, {
          name: `Pull ${folder.name}`,
          action: ScheduleAction.PULL,
          entityId: folder.id,
          cronExpression: selectedValue,
        });
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
          Define a schedule to automatically pull data from {folder.connectorDisplayName} for this table.
        </Text13Book>
        <Select
          label="Frequency"
          data={scheduleOptions}
          value={selectedValue}
          onChange={(val) => setSelectedValue(val ?? MANUAL_ONLY)}
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
      </Stack>
    </ModalWrapper>
  );
}
