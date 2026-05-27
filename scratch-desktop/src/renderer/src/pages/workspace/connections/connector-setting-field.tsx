import { Autocomplete, Checkbox, NumberInput, TextInput } from '@mantine/core';
import type { ConnectorSettingDefinition } from '@spinner/shared-types';

interface ConnectorSettingFieldProps {
  setting: ConnectorSettingDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
  fieldOptions?: string[];
  autoDetectedField?: string;
}

export function ConnectorSettingField({
  setting,
  value,
  onChange,
  fieldOptions,
  autoDetectedField,
}: ConnectorSettingFieldProps) {
  if (setting.type === 'boolean') {
    return (
      <Checkbox
        label={setting.label}
        description={setting.description}
        checked={(value as boolean) ?? false}
        onChange={(e) => onChange(e.currentTarget.checked)}
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
      />
    );
  }
  if (setting.type === 'field-select') {
    const current = (value as string) ?? '';
    return (
      <Autocomplete
        label={setting.label}
        description={setting.description}
        placeholder={
          !current && autoDetectedField
            ? `Auto-detected: ${autoDetectedField}`
            : (setting.placeholder ?? 'Select a field...')
        }
        data={fieldOptions ?? []}
        value={current}
        onChange={(val) => onChange(val)}
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
    />
  );
}
