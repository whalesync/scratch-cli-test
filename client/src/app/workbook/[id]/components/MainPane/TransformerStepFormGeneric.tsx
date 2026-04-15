'use client';

import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import {
  Box,
  Checkbox,
  ComboboxItem,
  Group,
  Select,
  Stack,
  Text,
  TextInput,
  useMantineColorScheme,
} from '@mantine/core';
import type {
  DataFolder,
  TransformerConfig,
  TransformerFieldDescriptor,
  TransformerMetadata,
} from '@spinner/shared-types';
import CodeMirror from '@uiw/react-codemirror';
import { useCallback } from 'react';

interface TransformerStepFormGenericProps {
  /** Metadata for all transformer types (for the type selector dropdown) */
  allMetadata: TransformerMetadata[];
  /** The current transformer config being edited */
  config: TransformerConfig;
  /** Called when the config changes */
  onChange: (c: TransformerConfig) => void;
  /** All folders in the workbook (for folder_picker widgets) */
  allFolders: DataFolder[];
}

const renderFolderOption = ({ option }: { option: ComboboxItem & { connectorService?: string | null } }) => (
  <Group gap="xs" wrap="nowrap">
    {option.connectorService && <ConnectorIcon connector={option.connectorService} size={16} p={0} />}
    <Text size="sm">{option.label}</Text>
  </Group>
);

/** Renders a single field based on its descriptor */
function FieldRenderer({
  field,
  value,
  onValueChange,
  allFolders,
  colorScheme,
}: {
  field: TransformerFieldDescriptor;
  value: unknown;
  onValueChange: (key: string, value: unknown) => void;
  allFolders: DataFolder[];
  colorScheme: string;
}) {
  switch (field.widget) {
    case 'select':
      return (
        <Select
          size="xs"
          label={field.label}
          description={field.description}
          placeholder={field.placeholder}
          data={field.selectOptions ?? []}
          value={(value as string) ?? null}
          onChange={(v) => v && onValueChange(field.key, v)}
        />
      );

    case 'checkbox':
      return (
        <Checkbox
          size="xs"
          label={field.label}
          description={field.description}
          checked={(value as boolean) ?? false}
          onChange={(e) => onValueChange(field.key, e.currentTarget.checked || undefined)}
        />
      );

    case 'text':
      return (
        <TextInput
          size="xs"
          label={field.label}
          description={field.description}
          placeholder={field.placeholder}
          value={(value as string) ?? ''}
          onChange={(e) => onValueChange(field.key, e.currentTarget.value)}
        />
      );

    case 'folder_picker': {
      const folders = field.assetFoldersOnly ? allFolders.filter((f) => f.isAssetTable) : allFolders;
      const folderSelectData = folders.map((f) => ({
        value: f.id,
        label: f.name ?? f.id,
        connectorService: f.connectorService,
      }));
      return (
        <Select
          size="xs"
          label={field.label}
          description={field.description}
          placeholder={field.placeholder ?? 'Select folder'}
          data={folderSelectData}
          value={(value as string) || null}
          onChange={(v) => v && onValueChange(field.key, v)}
          renderOption={renderFolderOption}
          searchable
        />
      );
    }

    case 'json_editor':
      return (
        <Box
          style={{
            border: '1px solid var(--mantine-color-default-border)',
            borderRadius: 'var(--mantine-radius-md)',
            overflow: 'hidden',
          }}
        >
          <Text size="xs" fw={500} mb={4}>
            {field.label}
          </Text>
          {field.description && (
            <Text size="xs" c="dimmed" mb={4}>
              {field.description}
            </Text>
          )}
          <CodeMirror
            value={JSON.stringify(value ?? {}, null, 2)}
            extensions={[json(), EditorView.lineWrapping]}
            theme={colorScheme === 'dark' ? 'dark' : 'light'}
            basicSetup={{
              lineNumbers: true,
              foldGutter: false,
              highlightActiveLine: false,
            }}
            style={{ fontSize: '12px' }}
            onChange={(newValue) => {
              try {
                const parsed: unknown = JSON.parse(newValue);
                if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
                  onValueChange(field.key, parsed);
                }
              } catch {
                // Don't update on invalid JSON
              }
            }}
          />
        </Box>
      );

    case 'transformer_config':
      return (
        <Box
          style={{
            border: '1px solid var(--mantine-color-default-border)',
            borderRadius: 'var(--mantine-radius-md)',
            overflow: 'hidden',
          }}
        >
          <Text size="xs" fw={500} mb={4}>
            {field.label}
          </Text>
          {field.description && (
            <Text size="xs" c="dimmed" mb={4}>
              {field.description}
            </Text>
          )}
          <CodeMirror
            value={JSON.stringify(value ?? {}, null, 2)}
            extensions={[json(), EditorView.lineWrapping]}
            theme={colorScheme === 'dark' ? 'dark' : 'light'}
            basicSetup={{
              lineNumbers: true,
              foldGutter: false,
              highlightActiveLine: false,
            }}
            style={{ fontSize: '12px' }}
            onChange={(newValue) => {
              try {
                const parsed: unknown = JSON.parse(newValue);
                if (typeof parsed === 'object' && parsed !== null && 'type' in parsed) {
                  onValueChange(field.key, parsed);
                }
              } catch {
                // Don't update on invalid JSON
              }
            }}
          />
        </Box>
      );

    default:
      return null;
  }
}

/** Generic transformer step form that renders fields from server-provided metadata. */
export function TransformerStepFormGeneric({
  allMetadata,
  config,
  onChange,
  allFolders,
}: TransformerStepFormGenericProps) {
  const { colorScheme } = useMantineColorScheme();
  const currentMeta = allMetadata.find((m) => m.type === config.type);
  const transformerSelectData = allMetadata.map((m) => ({ value: m.type, label: m.label }));

  const handleTypeChange = useCallback(
    (type: string) => {
      const meta = allMetadata.find((m) => m.type === type);
      onChange({ type, options: meta?.defaultOptions ?? {} } as TransformerConfig);
    },
    [allMetadata, onChange],
  );

  const handleFieldChange = useCallback(
    (key: string, value: unknown) => {
      onChange({
        ...config,
        options: { ...(config.options as Record<string, unknown>), [key]: value },
      } as TransformerConfig);
    },
    [config, onChange],
  );

  return (
    <Stack gap="xs" style={{ maxWidth: 400 }}>
      <Select
        size="xs"
        label="Type"
        data={transformerSelectData}
        value={config.type}
        onChange={(value) => value && handleTypeChange(value)}
      />
      {currentMeta?.fields.map((field) => {
        // Check conditional visibility
        if (field.visibleWhen) {
          const currentOptions = config.options as Record<string, unknown> | undefined;
          if (currentOptions?.[field.visibleWhen.field] !== field.visibleWhen.value) {
            return null;
          }
        }

        const currentValue = (config.options as Record<string, unknown> | undefined)?.[field.key];

        return (
          <FieldRenderer
            key={field.key}
            field={field}
            value={currentValue}
            onValueChange={handleFieldChange}
            allFolders={allFolders}
            colorScheme={colorScheme}
          />
        );
      })}
    </Stack>
  );
}

/** Returns true if a transformer config has all required fields filled in (non-empty). */
export function isTransformerConfigCompleteFromMetadata(
  config: TransformerConfig,
  metadata: TransformerMetadata[],
): boolean {
  const meta = metadata.find((m) => m.type === config.type);
  if (!meta) return true;
  return meta.fields
    .filter((f) => f.required)
    .every((f) => {
      const val = (config.options as Record<string, unknown>)?.[f.key];
      return val !== undefined && val !== null && val !== '';
    });
}

/** Creates a default config for a given transformer type using metadata defaults. */
export function defaultConfigFromMetadata(type: string, metadata: TransformerMetadata[]): TransformerConfig {
  const meta = metadata.find((m) => m.type === type);
  return { type, options: meta?.defaultOptions ?? {} } as TransformerConfig;
}
