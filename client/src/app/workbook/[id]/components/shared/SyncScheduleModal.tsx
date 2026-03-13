'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text13Book } from '@/app/components/base/text';
import { ModalWrapper } from '@/app/components/ModalWrapper';
import { useDevTools } from '@/hooks/use-dev-tools';
import { Select } from '@mantine/core';
import { useMemo, useState } from 'react';

interface SyncScheduleModalProps {
  opened: boolean;
  onClose: () => void;
  currentSchedule: string;
  onSave: (schedule: string) => void;
}

const MANUAL_ONLY = '';
const EVERY_MINUTE = '* * * * *';

const SCHEDULE_OPTIONS = [
  { value: MANUAL_ONLY, label: 'Manual only' },
  { value: '*/5 * * * *', label: 'Every 5 minutes' },
  { value: '*/15 * * * *', label: 'Every 15 minutes' },
  { value: '0 * * * *', label: 'Every hour' },
  { value: '0 0 * * *', label: 'Daily at midnight' },
];

const DEV_ONLY_OPTION = { value: EVERY_MINUTE, label: 'Every minute (internal use only)' };

export function SyncScheduleModal({ opened, onClose, currentSchedule, onSave }: SyncScheduleModalProps) {
  const { isDevToolsEnabled } = useDevTools();
  const [selectedValue, setSelectedValue] = useState<string>(currentSchedule);
  const [prevOpened, setPrevOpened] = useState(opened);

  if (opened && !prevOpened) {
    setSelectedValue(currentSchedule);
  }
  if (opened !== prevOpened) {
    setPrevOpened(opened);
  }

  const scheduleOptions = useMemo(
    () => (isDevToolsEnabled ? [...SCHEDULE_OPTIONS, DEV_ONLY_OPTION] : SCHEDULE_OPTIONS),
    [isDevToolsEnabled],
  );

  const handleSave = () => {
    onSave(selectedValue);
    onClose();
  };

  return (
    <ModalWrapper
      title="Sync schedule"
      opened={opened}
      onClose={onClose}
      customProps={{
        footer: (
          <>
            <ButtonSecondaryOutline onClick={onClose}>Cancel</ButtonSecondaryOutline>
            <ButtonPrimaryLight onClick={handleSave}>Save</ButtonPrimaryLight>
          </>
        ),
      }}
    >
      <Text13Book>Choose when this sync should run.</Text13Book>
      <Select
        label="Frequency"
        data={scheduleOptions}
        value={selectedValue}
        onChange={(val) => setSelectedValue(val ?? MANUAL_ONLY)}
        allowDeselect={false}
        mt="md"
        renderOption={({ option }) =>
          option.value === EVERY_MINUTE ? (
            <span style={{ color: 'var(--mantine-color-violet-6)' }}>{option.label}</span>
          ) : (
            <span>{option.label}</span>
          )
        }
      />
    </ModalWrapper>
  );
}

/** Get display label for a cron schedule value. Use context='toolbar' for inline display. */
export function getScheduleLabel(cronExpression: string, context?: 'toolbar'): string {
  if (!cronExpression || cronExpression === MANUAL_ONLY) {
    return context === 'toolbar' ? 'No scheduled runs' : 'Manual only';
  }
  const option = SCHEDULE_OPTIONS.find((o) => o.value === cronExpression);
  if (option) return option.label;
  if (cronExpression === EVERY_MINUTE) return 'Every minute';
  return cronExpression;
}
