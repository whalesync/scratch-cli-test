'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text13Book } from '@/app/components/base/text';
import { ModalWrapper } from '@/app/components/ModalWrapper';
import { useDevTools } from '@/hooks/use-dev-tools';
import { Stack } from '@mantine/core';
import { describeScheduleCron } from '@spinner/shared-types';
import { useMemo, useState } from 'react';
import { getScheduleTimezone, MANUAL_ONLY } from './pull-schedule-helpers';
import { ScheduleFrequencyPicker } from './ScheduleFrequencyPicker';

interface SyncScheduleModalProps {
  opened: boolean;
  onClose: () => void;
  currentSchedule: string;
  onSave: (schedule: string, timezone: string | null) => void;
}

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

  const browserTimezone = useMemo<string | null>(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
    } catch {
      return null;
    }
  }, []);

  const handleSave = () => {
    onSave(selectedValue, getScheduleTimezone(selectedValue));
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
      <Stack gap="md">
        <Text13Book>Choose when this sync should run.</Text13Book>
        <ScheduleFrequencyPicker
          label="Frequency"
          value={selectedValue}
          onChange={setSelectedValue}
          timezone={browserTimezone}
          showDevOption={isDevToolsEnabled}
        />
      </Stack>
    </ModalWrapper>
  );
}

/** Get display label for a cron schedule value. Use context='toolbar' for inline display. */
export function getScheduleLabel(cronExpression: string, context?: 'toolbar', timezone?: string | null): string {
  if (!cronExpression || cronExpression === MANUAL_ONLY) {
    return context === 'toolbar' ? 'No scheduled runs' : 'Manual only';
  }
  return describeScheduleCron(cronExpression, timezone);
}
