'use client';

import { Text12Regular } from '@/app/components/base/text';
import type { ComboboxItem } from '@mantine/core';
import { Group, Select, Stack } from '@mantine/core';
import { TimeInput } from '@mantine/dates';
import type { ScheduleFrequency, ScheduleParts } from '@spinner/shared-types';
import {
  buildScheduleCron,
  EVERY_MINUTE_SCHEDULE_CRON,
  isTimeBasedFrequency,
  parseScheduleCron,
  SCHEDULE_WEEKDAY_NAMES,
} from '@spinner/shared-types';
import { useState } from 'react';

/** Frequency options shown in every schedule modal (Pull, Sync, Routine). */
const FREQUENCY_OPTIONS: { value: ScheduleFrequency; label: string }[] = [
  { value: 'manual', label: 'Manual only' },
  { value: 'every5m', label: 'Every 5 minutes' },
  { value: 'every30m', label: 'Every 30 minutes' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

/** Extra option exposed only when dev tools are enabled. */
const DEV_FREQUENCY_OPTION: { value: ScheduleFrequency; label: string } = {
  value: 'everyMinute',
  label: 'Every minute (internal use only)',
};

/** Option used to surface a stored cron the picker can't represent with its structured controls. */
const CUSTOM_FREQUENCY_OPTION: { value: ScheduleFrequency; label: string } = {
  value: 'custom',
  label: 'Custom (advanced)',
};

const WEEKDAY_OPTIONS: ComboboxItem[] = SCHEDULE_WEEKDAY_NAMES.map((name, index) => ({
  value: String(index),
  label: name,
}));

const DAY_OF_MONTH_OPTIONS: ComboboxItem[] = Array.from({ length: 31 }, (_, index) => ({
  value: String(index + 1),
  label: String(index + 1),
}));

interface ScheduleFrequencyPickerProps {
  label?: string;
  description?: string;
  /** The current cron expression (controlled). Empty string = "Manual only". */
  value: string;
  onChange: (cron: string) => void;
  /** IANA timezone shown in the helper label for time-based frequencies (null = UTC). */
  timezone: string | null;
  disabled?: boolean;
  /** Whether to include the dev-only "Every minute" frequency. */
  showDevOption?: boolean;
}

function timeToString(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * A time-of-day field that buffers what the user types in its own state so manual digit entry
 * isn't fought by the parent's controlled value. The native time input keeps its segment focus
 * because `value` mirrors exactly what's in the field; a completed, valid time is pushed up via
 * `onTimeChange`. The buffer re-seeds (during render) when the time changes from outside — e.g. a
 * frequency switch that alters the time, or the modal re-opening on a different schedule.
 */
function ScheduleTimeInput({
  hour,
  minute,
  onTimeChange,
  disabled,
}: {
  hour: number;
  minute: number;
  onTimeChange: (hour: number, minute: number) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState(() => timeToString(hour, minute));
  const [syncedFrom, setSyncedFrom] = useState({ hour, minute });

  if (syncedFrom.hour !== hour || syncedFrom.minute !== minute) {
    setSyncedFrom({ hour, minute });
    setText(timeToString(hour, minute));
  }

  return (
    <TimeInput
      label="Time"
      value={text}
      disabled={disabled}
      onChange={(event) => {
        const next = event.currentTarget.value;
        setText(next);
        const [hourStr, minuteStr] = next.split(':');
        const parsedHour = Number(hourStr);
        const parsedMinute = Number(minuteStr);
        if (
          next !== '' &&
          Number.isInteger(parsedHour) &&
          Number.isInteger(parsedMinute) &&
          parsedHour >= 0 &&
          parsedHour <= 23 &&
          parsedMinute >= 0 &&
          parsedMinute <= 59
        ) {
          onTimeChange(parsedHour, parsedMinute);
        }
      }}
    />
  );
}

/**
 * Frequency selector shared by all three schedule modals. It edits a cron expression through a
 * structured frequency dropdown plus conditional controls — a time-of-day for daily/weekly/monthly,
 * a weekday for weekly, and a day-of-month for monthly — and surfaces the timezone the time is
 * interpreted in. The cron string stays the source of truth: the picker is fully controlled, deriving
 * its parts from `value` each render with `parseScheduleCron` and re-emitting via `buildScheduleCron`
 * (an unrecognized cron is passed through untouched as `custom`). The time-of-day survives a
 * frequency switch because it is encoded in every time-based cron.
 */
export function ScheduleFrequencyPicker({
  label = 'Frequency',
  description,
  value,
  onChange,
  timezone,
  disabled = false,
  showDevOption = false,
}: ScheduleFrequencyPickerProps) {
  const parts = parseScheduleCron(value);

  const emit = (nextParts: ScheduleParts) => onChange(buildScheduleCron(nextParts));

  const frequencyOptions: ComboboxItem[] = [
    ...FREQUENCY_OPTIONS,
    ...(showDevOption ? [DEV_FREQUENCY_OPTION] : []),
    ...(parts.frequency === 'custom' ? [CUSTOM_FREQUENCY_OPTION] : []),
  ];

  const isTimeBased = isTimeBasedFrequency(parts.frequency);

  return (
    <Stack gap="xs">
      <Select
        label={label}
        description={description}
        data={frequencyOptions}
        value={parts.frequency}
        onChange={(val) => emit({ ...parts, frequency: (val as ScheduleFrequency) ?? 'manual' })}
        disabled={disabled}
        allowDeselect={false}
        renderOption={({ option }) =>
          option.value === EVERY_MINUTE_SCHEDULE_CRON || option.value === 'everyMinute' ? (
            <span style={{ color: 'var(--mantine-color-violet-6)' }}>{option.label}</span>
          ) : (
            <span>{option.label}</span>
          )
        }
      />

      {parts.frequency === 'custom' && (
        <Text12Regular c="var(--fg-secondary)">
          Custom schedule (<code>{parts.raw}</code>). Choose a frequency above to replace it.
        </Text12Regular>
      )}

      {isTimeBased && (
        <Group align="flex-end" grow wrap="nowrap">
          {parts.frequency === 'weekly' && (
            <Select
              label="Day of week"
              data={WEEKDAY_OPTIONS}
              value={String(parts.dayOfWeek)}
              onChange={(val) => emit({ ...parts, dayOfWeek: Number(val ?? parts.dayOfWeek) })}
              disabled={disabled}
              allowDeselect={false}
            />
          )}
          {parts.frequency === 'monthly' && (
            <Select
              label="Day of month"
              data={DAY_OF_MONTH_OPTIONS}
              value={String(parts.dayOfMonth)}
              onChange={(val) => emit({ ...parts, dayOfMonth: Number(val ?? parts.dayOfMonth) })}
              disabled={disabled}
              allowDeselect={false}
            />
          )}
          <ScheduleTimeInput
            hour={parts.hour}
            minute={parts.minute}
            onTimeChange={(hour, minute) => emit({ ...parts, hour, minute })}
            disabled={disabled}
          />
        </Group>
      )}

      {isTimeBased && (
        <Text12Regular c="var(--fg-secondary)">
          Times are in your timezone{timezone ? `: ${timezone}` : ''}.
        </Text12Regular>
      )}

      {parts.frequency === 'monthly' && parts.dayOfMonth >= 29 && (
        <Text12Regular c="var(--mantine-color-orange-7)">
          Day {parts.dayOfMonth} doesn&apos;t exist in every month — this schedule will skip months that are shorter.
        </Text12Regular>
      )}
    </Stack>
  );
}
