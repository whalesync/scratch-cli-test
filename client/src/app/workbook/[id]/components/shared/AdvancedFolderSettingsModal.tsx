'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { ModalWrapper } from '@/app/components/ModalWrapper';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { useDataFolders } from '@/hooks/use-data-folders';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { connectorAccountsApi } from '@/lib/api/connector-accounts';
import { dataFolderApi } from '@/lib/api/data-folder';
import { SWR_KEYS } from '@/lib/api/keys';
import { useWorkbookUIStore } from '@/stores/workbook-ui-store';
import { isTableFullyLocked, TableList } from '@/types/server-entities/table-list';
import { isExperimentEnabled } from '@/types/server-entities/users';
import {
  Autocomplete,
  Checkbox,
  Group,
  Loader,
  NumberInput,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import type { ConnectorSettingDefinition, DataFolder, DataFolderOptions } from '@spinner/shared-types';
import { X_SCRATCH_LAST_MODIFIED_FIELD } from '@spinner/shared-types';
import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';

interface AdvancedFolderSettingsModalProps {
  opened: boolean;
  onClose: () => void;
  folder: DataFolder;
}

/**
 * Walk a stored table spec and return the candidate field names for the
 * "Last modified time field" picker. `GET /data-folder/:id/schema` returns the
 * full `BaseJsonTableSpec`, so the JSON Schema is nested under `.schema`.
 * Mirrors the server's `findLastModifiedFieldName` traversal
 * (`schema.properties.fields.properties`), falling back to top-level
 * `properties` for flat/SQL schemas. `autoDetected` is the first field
 * annotated with `x-scratch-last-modified-field`.
 */
function extractSchemaFields(spec: Record<string, unknown> | undefined): {
  names: string[];
  autoDetected: string | undefined;
} {
  if (!spec) return { names: [], autoDetected: undefined };
  const schema = (spec.schema as Record<string, unknown> | undefined) ?? spec;
  const properties = schema.properties as Record<string, unknown> | undefined;
  const fields = properties?.fields as Record<string, unknown> | undefined;
  const fieldProps = (fields?.properties as Record<string, unknown> | undefined) ?? properties;
  if (!fieldProps) return { names: [], autoDetected: undefined };

  const names: string[] = [];
  let autoDetected: string | undefined;
  for (const name of Object.keys(fieldProps)) {
    names.push(name);
    const node = fieldProps[name];
    if (
      autoDetected === undefined &&
      node !== null &&
      typeof node === 'object' &&
      (node as Record<string, unknown>)[X_SCRATCH_LAST_MODIFIED_FIELD] === true
    ) {
      autoDetected = name;
    }
  }
  names.sort((a, b) => a.localeCompare(b));
  return { names, autoDetected };
}

function ConnectorSettingField({
  setting,
  value,
  onChange,
  fieldOptions,
  autoDetectedField,
}: {
  setting: ConnectorSettingDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
  fieldOptions?: string[];
  autoDetectedField?: string;
}) {
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
        // When unset, surface the auto-detected field so users with a typed
        // last-modified column see incremental works with no input. A free
        // typed value is still accepted (Autocomplete) for untyped columns.
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

export function AdvancedFolderSettingsModal({ opened, onClose, folder }: AdvancedFolderSettingsModalProps) {
  const workbookId = useWorkbookUIStore((state) => state.workbookId);
  const { refresh: refreshDataFolders } = useDataFolders();
  const { metadata } = useConnectorsMetadata();
  const { user } = useScratchPadUser();
  const [filter, setFilter] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [settingValues, setSettingValues] = useState<Record<string, unknown>>({});

  const { data: tableList, isLoading: isLoadingMetadata } = useSWR<TableList>(
    opened && workbookId && folder.connectorAccountId
      ? SWR_KEYS.connectorAccounts.tables(workbookId, folder.connectorAccountId)
      : null,
    () => connectorAccountsApi.listTables(workbookId!, folder.connectorAccountId!),
    { revalidateOnFocus: false },
  );

  const supportsFilters = tableList?.supportsFilters ?? false;
  const advancedSettings = useMemo(() => tableList?.advancedSettings ?? [], [tableList?.advancedSettings]);

  // Incremental controls (the `field-select` last-modified-field picker) are
  // gated on the kill-switch flag AND the connector's static incremental
  // capability — same rule as the sidebar menu items and schedule modal.
  const incrementalEnabled =
    isExperimentEnabled('INCREMENTAL_POLLING_ENABLED', user) &&
    (folder.connectorService ? Boolean(metadata?.[folder.connectorService]?.incrementalPull) : false);

  // Hide `field-select` settings when incremental is disabled. Filtered only
  // for rendering / the schema fetch — buildOptions and the init effect still
  // iterate the full list so a previously-saved modifiedAtField is preserved.
  const visibleSettings = useMemo(
    () => (incrementalEnabled ? advancedSettings : advancedSettings.filter((s) => s.type !== 'field-select')),
    [incrementalEnabled, advancedSettings],
  );

  // Only fetch the schema when a visible field-select setting is present.
  // Reuse the 'view' schema key so this shares the cache with the schema modal.
  const hasFieldSelect = useMemo(() => visibleSettings.some((s) => s.type === 'field-select'), [visibleSettings]);
  const { data: schemaData } = useSWR<Record<string, unknown>>(
    opened && hasFieldSelect ? SWR_KEYS.dataFolders.schema(folder.id, 'view') : null,
    () => dataFolderApi.getSchema(folder.id),
    { revalidateOnFocus: false },
  );
  const { names: schemaFieldNames, autoDetected: autoDetectedField } = useMemo(
    () => extractSchemaFields(schemaData),
    [schemaData],
  );

  // Look up this folder's TablePreview so we can detect connector-level lockout.
  const tablePreview = useMemo(() => {
    if (!tableList || folder.tableId.length === 0) return undefined;
    const key = folder.tableId.join('/');
    return tableList.tables.find((t) => t.id.remoteId.join('/') === key);
  }, [tableList, folder.tableId]);
  const fullyLocked = isTableFullyLocked(tablePreview);

  useEffect(() => {
    if (opened) {
      const opts = (folder.options ?? {}) as DataFolderOptions;
      setFilter(opts.filter ?? '');
      setReadOnly(Boolean(opts.readOnly));

      const values: Record<string, unknown> = {};
      for (const setting of advancedSettings) {
        const stored = opts[setting.key];
        values[setting.key] = stored ?? (setting.type === 'boolean' ? false : '');
      }
      setSettingValues(values);
    }
  }, [opened, folder.options, advancedSettings]);

  // Build the merged options blob to send to the server. Preserves existing
  // keys so unrelated values (idFieldOverride, nameFieldOverride) survive.
  const buildOptions = (): Record<string, unknown> => {
    const opts: Record<string, unknown> = { ...((folder.options ?? {}) as Record<string, unknown>) };

    if (fullyLocked || readOnly) {
      opts.readOnly = true;
    } else {
      delete opts.readOnly;
    }

    for (const setting of advancedSettings) {
      const value = settingValues[setting.key];
      if (setting.type === 'boolean' && value === true) {
        opts[setting.key] = true;
      } else if (setting.type === 'number' && value !== '' && value != null) {
        opts[setting.key] = value;
      } else if (
        (setting.type === 'string' || setting.type === 'password' || setting.type === 'field-select') &&
        typeof value === 'string' &&
        value.trim()
      ) {
        opts[setting.key] = value.trim();
      } else {
        delete opts[setting.key];
      }
    }
    return opts;
  };

  const updateSettingValue = (key: string, value: unknown) => {
    setSettingValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      await dataFolderApi.update(folder.id, {
        filter: filter.trim() || null,
        options: buildOptions(),
      });
      await refreshDataFolders();
      ScratchpadNotifications.success({
        title: 'Settings Updated',
        message: `Updated settings for ${folder.name}`,
      });
      onClose();
    } catch (error) {
      console.debug('Failed to update folder settings', error);
      ScratchpadNotifications.error({
        title: 'Update Failed',
        message: 'Could not update folder settings.',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <ModalWrapper
      title="Advanced Settings"
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
      {isLoadingMetadata ? (
        <Group justify="center" py="xl">
          <Loader size="sm" />
        </Group>
      ) : (
        <Stack>
          <Textarea
            label="Filter"
            description={
              supportsFilters
                ? 'Filter expression applied when pulling records from this table.'
                : 'Filters are not supported for this connector.'
            }
            placeholder={supportsFilters ? 'Enter filter expression...' : ''}
            value={filter}
            onChange={(e) => setFilter(e.currentTarget.value)}
            disabled={!supportsFilters}
            autosize
            minRows={3}
            maxRows={6}
          />

          <Stack gap={4}>
            <Text size="sm" fw={500}>
              Read-only
            </Text>
            <Group gap={8} wrap="nowrap" align="center">
              <Tooltip
                label="This connector doesn't support writes to this table."
                disabled={!fullyLocked}
                position="right"
              >
                <Switch
                  checked={fullyLocked || readOnly}
                  disabled={fullyLocked}
                  onChange={(e) => setReadOnly(e.currentTarget.checked)}
                  size="sm"
                />
              </Tooltip>
              <Text size="xs" c="dimmed">
                {fullyLocked || readOnly
                  ? `Scratch will not push changes to ${folder.connectorDisplayName ?? 'the remote'}`
                  : `Scratch will be able to push to ${folder.connectorDisplayName ?? 'the remote'}`}
              </Text>
            </Group>
          </Stack>

          {visibleSettings.map((setting) => (
            <ConnectorSettingField
              key={setting.key}
              setting={setting}
              value={settingValues[setting.key]}
              onChange={(val) => updateSettingValue(setting.key, val)}
              fieldOptions={schemaFieldNames}
              autoDetectedField={autoDetectedField}
            />
          ))}
        </Stack>
      )}
    </ModalWrapper>
  );
}
