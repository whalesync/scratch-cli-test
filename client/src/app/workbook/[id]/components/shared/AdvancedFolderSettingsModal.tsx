'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text12Book, Text13Regular, TextTitle4 } from '@/app/components/base/text';
import { ModalWrapper } from '@/app/components/ModalWrapper';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { getServiceName, useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { useDataFolders } from '@/hooks/use-data-folders';
import { connectorAccountsApi } from '@/lib/api/connector-accounts';
import { dataFolderApi } from '@/lib/api/data-folder';
import { SWR_KEYS } from '@/lib/api/keys';
import { useWorkbookUIStore } from '@/stores/workbook-ui-store';
import { isTableFullyLocked, TableList } from '@/types/server-entities/table-list';
import {
  Autocomplete,
  Checkbox,
  Divider,
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
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import useSWR from 'swr';

interface AdvancedFolderSettingsModalProps {
  opened: boolean;
  onClose: () => void;
  folder: DataFolder;
}

/**
 * The advanced setting that selects the table's last-modified field is the one
 * that drives incremental pull, so it is rendered under the Incremental Pull
 * section rather than alongside the other connector-specific settings.
 */
const INCREMENTAL_PULL_FIELD_SETTING_KEY = 'modifiedAtField';

/**
 * One labelled section of the advanced-settings form (e.g. "Incremental Pull").
 * Renders a title above its content with a divider separating it from the
 * previous section.
 */
function SettingsSection({
  title,
  withDivider,
  children,
}: {
  title: string;
  withDivider: boolean;
  children: ReactNode;
}) {
  return (
    <Stack gap={8}>
      {withDivider && <Divider />}
      <TextTitle4>{title}</TextTitle4>
      {children}
    </Stack>
  );
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
  formatByFieldName: Record<string, string | undefined>;
} {
  if (!spec) return { names: [], autoDetected: undefined, formatByFieldName: {} };
  const schema = (spec.schema as Record<string, unknown> | undefined) ?? spec;
  const properties = schema.properties as Record<string, unknown> | undefined;
  const fields = properties?.fields as Record<string, unknown> | undefined;
  const fieldProps = (fields?.properties as Record<string, unknown> | undefined) ?? properties;
  if (!fieldProps) return { names: [], autoDetected: undefined, formatByFieldName: {} };

  const names: string[] = [];
  const formatByFieldName: Record<string, string | undefined> = {};
  let autoDetected: string | undefined;
  for (const name of Object.keys(fieldProps)) {
    names.push(name);
    const node = fieldProps[name];
    formatByFieldName[name] = resolveSchemaFieldFormat(node);
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
  return { names, autoDetected, formatByFieldName };
}

/**
 * Resolve a schema field's JSON Schema `format`, looking inside `anyOf`/`oneOf`
 * unions so a nullable column (e.g. `{ anyOf: [{ format: 'date-time' }, { type:
 * 'null' }] }`) still reports its underlying format.
 */
function resolveSchemaFieldFormat(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;
  if (typeof obj.format === 'string') return obj.format;
  for (const unionKey of ['anyOf', 'oneOf', 'allOf'] as const) {
    const variants = obj[unionKey];
    if (Array.isArray(variants)) {
      for (const variant of variants) {
        const found = resolveSchemaFieldFormat(variant);
        if (found) return found;
      }
    }
  }
  return undefined;
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
  const { metadata, isLoading: isLoadingConnectorsMetadata } = useConnectorsMetadata();
  const [filter, setFilter] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [settingValues, setSettingValues] = useState<Record<string, unknown>>({});

  const { data: tableList, isLoading: isLoadingMetadata } = useSWR<TableList>(
    opened && workbookId && folder.connectorAccountId
      ? SWR_KEYS.connectorAccounts.tables(workbookId, folder.connectorAccountId)
      : null,
    () => {
      if (!workbookId || !folder.connectorAccountId) {
        throw new Error('listTables fetcher requires a workbookId and connectorAccountId');
      }
      return connectorAccountsApi.listTables(workbookId, folder.connectorAccountId);
    },
    { revalidateOnFocus: false },
  );

  const supportsFilters = tableList?.supportsFilters ?? false;
  const advancedSettings = useMemo(() => tableList?.advancedSettings ?? [], [tableList?.advancedSettings]);

  // Connector-level incremental-pull capability and its user-facing note, gated
  // the same way as the sidebar menu items and schedule modal.
  const incrementalPullSupported = folder.connectorService
    ? Boolean(metadata?.[folder.connectorService]?.incrementalPull)
    : false;
  const incrementalPullInstructions = folder.connectorService
    ? (metadata?.[folder.connectorService]?.incrementalPullInstructions ?? null)
    : null;
  const connectorDisplayName = getServiceName(metadata, folder.connectorService);

  // The last-modified-field picker belongs to the Incremental Pull section; all
  // other advanced settings are connector-specific and render under their own
  // "<Connector> Settings" section.
  const incrementalPullFieldSettings = useMemo(
    () => advancedSettings.filter((s) => s.key === INCREMENTAL_PULL_FIELD_SETTING_KEY),
    [advancedSettings],
  );
  const connectorSpecificSettings = useMemo(
    () => advancedSettings.filter((s) => s.key !== INCREMENTAL_PULL_FIELD_SETTING_KEY),
    [advancedSettings],
  );

  // Only fetch the schema when a field-select that will actually render is
  // present (reusing the 'view' schema key to share cache with the schema
  // modal). The incremental field-select renders only when the connector
  // supports incremental pull; connector-specific field-selects always render.
  const hasFieldSelect = useMemo(
    () =>
      (incrementalPullSupported && incrementalPullFieldSettings.some((s) => s.type === 'field-select')) ||
      connectorSpecificSettings.some((s) => s.type === 'field-select'),
    [incrementalPullSupported, incrementalPullFieldSettings, connectorSpecificSettings],
  );
  const { data: schemaData } = useSWR<Record<string, unknown>>(
    opened && hasFieldSelect ? SWR_KEYS.dataFolders.schema(folder.id, 'view') : null,
    () => dataFolderApi.getSchema(folder.id),
    { revalidateOnFocus: false },
  );
  const {
    names: schemaFieldNames,
    autoDetected: autoDetectedField,
    formatByFieldName: schemaFieldFormats,
  } = useMemo(() => extractSchemaFields(schemaData), [schemaData]);

  // Options offered by a `field-select` picker. When the setting declares
  // `fieldSelectFormats`, only fields whose schema `format` matches are offered
  // (e.g. timestamp-only columns for a last-modified picker); otherwise all
  // fields are offered.
  const fieldOptionsForSetting = (setting: ConnectorSettingDefinition): string[] => {
    if (!setting.fieldSelectFormats || setting.fieldSelectFormats.length === 0) return schemaFieldNames;
    const allowedFormats = setting.fieldSelectFormats;
    return schemaFieldNames.filter((name) => {
      const format = schemaFieldFormats[name];
      return format !== undefined && allowedFormats.includes(format);
    });
  };

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
        <Stack gap="lg">
          <Stack gap="md">
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

            {supportsFilters ? (
              <Textarea
                label="Filter"
                description="Filter expression applied when pulling records from this table."
                placeholder="Enter filter expression..."
                value={filter}
                onChange={(e) => setFilter(e.currentTarget.value)}
                autosize
                minRows={3}
                maxRows={6}
              />
            ) : (
              <Text13Regular c="dimmed">Filters are not supported for {connectorDisplayName}.</Text13Regular>
            )}
          </Stack>

          <SettingsSection title="Incremental Pull" withDivider>
            {isLoadingConnectorsMetadata ? (
              <Group justify="center" py="md">
                <Loader size="sm" />
              </Group>
            ) : incrementalPullSupported ? (
              <Stack gap={8}>
                {incrementalPullInstructions && <Text12Book c="dimmed">{incrementalPullInstructions}</Text12Book>}
                {incrementalPullFieldSettings.map((setting) => (
                  <ConnectorSettingField
                    key={setting.key}
                    setting={setting}
                    value={settingValues[setting.key]}
                    onChange={(val) => updateSettingValue(setting.key, val)}
                    fieldOptions={fieldOptionsForSetting(setting)}
                    autoDetectedField={autoDetectedField}
                  />
                ))}
                {incrementalPullFieldSettings.length === 0 && !incrementalPullInstructions && (
                  <Text13Regular c="dimmed">Incremental pull is supported for {connectorDisplayName}.</Text13Regular>
                )}
              </Stack>
            ) : (
              <Text13Regular c="dimmed">Incremental pull is not supported for {connectorDisplayName}.</Text13Regular>
            )}
          </SettingsSection>

          {connectorSpecificSettings.length > 0 && (
            <SettingsSection title={`${connectorDisplayName} Settings`} withDivider>
              {connectorSpecificSettings.map((setting) => (
                <ConnectorSettingField
                  key={setting.key}
                  setting={setting}
                  value={settingValues[setting.key]}
                  onChange={(val) => updateSettingValue(setting.key, val)}
                  fieldOptions={fieldOptionsForSetting(setting)}
                  autoDetectedField={autoDetectedField}
                />
              ))}
            </SettingsSection>
          )}
        </Stack>
      )}
    </ModalWrapper>
  );
}
