'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text13Book } from '@/app/components/base/text';
import { ModalWrapper } from '@/app/components/ModalWrapper';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { Stack, Switch } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  describeScheduleCron,
  ScheduleAction,
  type Schedule,
  type UpdateScheduleDto,
  type WorkbookId,
} from '@spinner/shared-types';
import { useMemo, useState } from 'react';
import { getScheduleTimezone, MANUAL_ONLY } from './pull-schedule-helpers';
import { ScheduleFrequencyPicker } from './ScheduleFrequencyPicker';

/** Toolbar label for a routine's cron value. '' → "No scheduled runs". */
export function getRoutineScheduleLabel(cronExpression: string, timezone?: string | null): string {
  if (!cronExpression || cronExpression === MANUAL_ONLY) {
    return 'No scheduled runs';
  }
  return describeScheduleCron(cronExpression, timezone);
}

interface RoutineScheduleModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
  routineFilePath: string;
  routineName: string;
  /** The routine's existing ROUTINE schedule row, or null when it has none. */
  existingSchedule: Schedule | null;
  /** Fired after a successful save so the caller can re-fetch routines + schedules. */
  onSaved: () => void | Promise<void>;
}

/**
 * Sets a routine's schedule. The cron lives in the Schedule DB table (action ROUTINE, entityId =
 * routine file path) — never in the routine YAML (DEV-10478). "Manual only" deletes the row; any
 * other frequency creates or updates it. Routines use a 5-minute minimum interval, so the
 * every-minute option offered for syncs is intentionally not available here.
 */
export function RoutineScheduleModal({
  opened,
  onClose,
  workbookId,
  routineFilePath,
  routineName,
  existingSchedule,
  onSaved,
}: RoutineScheduleModalProps) {
  const [selectedValue, setSelectedValue] = useState<string>(existingSchedule?.cronExpression ?? MANUAL_ONLY);
  const [enabled, setEnabled] = useState<boolean>(existingSchedule?.enabled ?? true);
  const [prevOpened, setPrevOpened] = useState(opened);
  const [isSaving, setIsSaving] = useState(false);

  const browserTimezone = useMemo<string | null>(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
    } catch {
      return null;
    }
  }, []);

  // Re-seed the form from the latest schedule each time the modal opens.
  if (opened && !prevOpened) {
    setSelectedValue(existingSchedule?.cronExpression ?? MANUAL_ONLY);
    setEnabled(existingSchedule?.enabled ?? true);
  }
  if (opened !== prevOpened) {
    setPrevOpened(opened);
  }

  const handleSave = async () => {
    setIsSaving(true);
    try {
      if (selectedValue === MANUAL_ONLY) {
        if (existingSchedule) {
          await scratchApiClient.schedule.delete(workbookId, existingSchedule.id);
        }
      } else if (!existingSchedule) {
        await scratchApiClient.schedule.create(workbookId, {
          name: routineName,
          action: ScheduleAction.ROUTINE,
          entityId: routineFilePath,
          cronExpression: selectedValue,
          timezone: getScheduleTimezone(selectedValue),
          enabled,
        });
      } else {
        // Only send the fields that actually changed; keep the schedule name in sync with the routine.
        const patch: UpdateScheduleDto = {};
        if (existingSchedule.cronExpression !== selectedValue) {
          patch.cronExpression = selectedValue;
          patch.timezone = getScheduleTimezone(selectedValue);
        }
        if (existingSchedule.enabled !== enabled) patch.enabled = enabled;
        if (existingSchedule.name !== routineName) patch.name = routineName;
        if (Object.keys(patch).length > 0) {
          await scratchApiClient.schedule.update(workbookId, existingSchedule.id, patch);
        }
      }
      await onSaved();
      notifications.show({ title: 'Routine schedule updated', message: routineFilePath, color: 'green' });
      onClose();
    } catch (err) {
      // The server rejects an invalid cron / sub-5-minute interval with a clear message — surface it.
      const message = err instanceof Error ? err.message : 'Failed to update the routine schedule.';
      notifications.show({ title: 'Could not update schedule', message, color: 'red' });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <ModalWrapper
      title="Routine schedule"
      opened={opened}
      onClose={onClose}
      customProps={{
        footer: (
          <>
            <ButtonSecondaryOutline onClick={onClose}>Cancel</ButtonSecondaryOutline>
            <ButtonPrimaryLight onClick={handleSave} loading={isSaving}>
              Save
            </ButtonPrimaryLight>
          </>
        ),
      }}
    >
      <Stack gap="md">
        <Text13Book>
          Choose when this routine runs. The schedule is managed separately from the routine file.
        </Text13Book>
        <ScheduleFrequencyPicker
          label="Frequency"
          value={selectedValue}
          onChange={setSelectedValue}
          timezone={browserTimezone}
        />
        {selectedValue !== MANUAL_ONLY && (
          <Switch
            label="Enabled"
            description="Turn off to keep the schedule configured but paused."
            checked={enabled}
            onChange={(event) => setEnabled(event.currentTarget.checked)}
          />
        )}
      </Stack>
    </ModalWrapper>
  );
}
