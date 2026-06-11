import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/components/base/buttons';
import { Text12Book, Text13Regular, TextTitle4 } from '@/components/base/text';
import { useConnectorAccounts } from '@/hooks/use-connector-accounts';
import { getServiceName, useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { useDataFolders } from '@/hooks/use-data-folders';
import { isTableFullyLocked } from '@/lib/connector-table-helpers';
import { scratchApiClient } from '@/lib/scratch-api-client';
import { Divider, Group, Loader, Modal, Stack, Switch, Text, Textarea, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { settingAppliesToTable, type DataFolder, type DataFolderOptions, type TableList } from '@spinner/shared-types';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import useSWR from 'swr';
import { ConnectorSettingField } from './connector-setting-field';

interface AdvancedFolderSettingsModalProps {
  opened: boolean;
  onClose: () => void;
  folder: DataFolder;
  workbookId: string;
}

/**
 * The advanced setting that selects the table's last-modified field is the one
 * that drives incremental pull, so it is rendered under the Incremental Pull
 * section rather than alongside the other connector-specific settings.
 */
const INCREMENTAL_PULL_FIELD_SETTING_KEY = 'modifiedAtField';

/**
 * One labelled section of the advanced-settings form (e.g. "Common",
 * "Filtering", "Incremental Pull"). Renders a title above its content with a
 * divider separating it from the previous section.
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

/**
 * Extract field names from a stored table schema spec for the "Last modified field" picker.
 * Also returns each field's JSON Schema `format` (used to filter `field-select`
 * pickers that declare `fieldSelectFormats`) and the schema-annotated
 * auto-detected last-modified field, if any.
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
      (node as Record<string, unknown>)['x-scratch-last-modified-field'] === true
    ) {
      autoDetected = name;
    }
  }
  names.sort((a, b) => a.localeCompare(b));
  return { names, autoDetected, formatByFieldName };
}

export function AdvancedFolderSettingsModal({ opened, onClose, folder, workbookId }: AdvancedFolderSettingsModalProps) {
  const { refresh: refreshDataFolders } = useDataFolders(workbookId);
  const { connectorAccounts } = useConnectorAccounts(workbookId);
  const [filter, setFilter] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [settingValues, setSettingValues] = useState<Record<string, unknown>>({});

  const connectorAccount = connectorAccounts.find((ca) => ca.id === folder.connectorAccountId);

  const { data: connectorsMetadata, isLoading: isLoadingConnectorsMetadata } = useConnectorsMetadata();
  const connectorMetadata = connectorAccount ? connectorsMetadata?.[connectorAccount.service] : undefined;
  const connectorDisplayName = connectorAccount
    ? getServiceName(connectorsMetadata, connectorAccount.service)
    : 'this connector';
  const incrementalPullSupported = connectorMetadata?.incrementalPull ?? false;
  const incrementalPullInstructions = connectorMetadata?.incrementalPullInstructions ?? null;

  const { data: tableList, isLoading: isLoadingMetadata } = useSWR<TableList>(
    opened && folder.connectorAccountId ? ['tables', workbookId, folder.connectorAccountId] : null,
    () => {
      if (!folder.connectorAccountId) throw new Error('connectorAccountId is required');
      return scratchApiClient.connectorAccounts.listTables(workbookId, folder.connectorAccountId);
    },
    { revalidateOnFocus: false },
  );

  const supportsFilters = tableList?.supportsFilters ?? false;
  const advancedSettings = useMemo(() => tableList?.advancedSettings ?? [], [tableList?.advancedSettings]);

  // Look up this folder's TablePreview to detect connector-level lockout and to
  // scope per-table settings (forTableWsIds). Defined above the settings memos
  // so they can filter by it.
  const tablePreview = useMemo(() => {
    if (!tableList || folder.tableId.length === 0) return undefined;
    const key = folder.tableId.join('/');
    return tableList.tables.find((t) => t.id.remoteId.join('/') === key);
  }, [tableList, folder.tableId]);
  const fullyLocked = isTableFullyLocked(tablePreview);

  // The last-modified-field picker belongs to the Incremental Pull section; all
  // other advanced settings are connector-specific and render under their own
  // "<Connector> Settings" section. Both are scoped by `forTableWsIds` so a
  // setting can target specific tables (settingAppliesToTable; omitted = all).
  // buildOptions and the init effect still iterate the full advancedSettings
  // list, so a previously-saved value on a now-hidden setting is preserved.
  const incrementalPullFieldSettings = useMemo(
    () =>
      advancedSettings.filter(
        (s) => s.key === INCREMENTAL_PULL_FIELD_SETTING_KEY && settingAppliesToTable(s, tablePreview?.id.wsId),
      ),
    [advancedSettings, tablePreview],
  );
  const connectorSpecificSettings = useMemo(
    () =>
      advancedSettings.filter(
        (s) => s.key !== INCREMENTAL_PULL_FIELD_SETTING_KEY && settingAppliesToTable(s, tablePreview?.id.wsId),
      ),
    [advancedSettings, tablePreview],
  );

  const hasFieldSelect = useMemo(() => advancedSettings.some((s) => s.type === 'field-select'), [advancedSettings]);
  const { data: schemaData } = useSWR<Record<string, unknown>>(
    opened && hasFieldSelect ? ['folder-schema', folder.id] : null,
    () => scratchApiClient.dataFolders.getSchema(folder.id),
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
  const fieldOptionsForSetting = (setting: { fieldSelectFormats?: string[] }): string[] => {
    if (!setting.fieldSelectFormats || setting.fieldSelectFormats.length === 0) return schemaFieldNames;
    const allowedFormats = setting.fieldSelectFormats;
    return schemaFieldNames.filter((name) => {
      const format = schemaFieldFormats[name];
      return format !== undefined && allowedFormats.includes(format);
    });
  };

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

  const buildOptions = (): Record<string, unknown> => {
    const opts: Record<string, unknown> = { ...(folder.options ?? {}) };

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
      await scratchApiClient.dataFolders.update(folder.id, {
        filter: filter.trim() || null,
        options: buildOptions(),
      });
      await refreshDataFolders();
      notifications.show({
        title: 'Settings Updated',
        message: `Updated settings for ${folder.name}`,
        color: 'teal',
      });
      onClose();
    } catch (error) {
      console.debug('Failed to update folder settings', error);
      notifications.show({
        title: 'Update Failed',
        message: 'Could not update folder settings.',
        color: 'red',
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal opened={opened} onClose={onClose} title="Advanced Settings" size="md" centered>
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
                    ? `Scratch will not push changes to ${connectorAccount?.displayName ?? 'the remote'}`
                    : `Scratch will be able to push to ${connectorAccount?.displayName ?? 'the remote'}`}
                </Text>
              </Group>
            </Stack>
          </Stack>
          <SettingsSection title="Filters" withDivider>
            {supportsFilters ? (
              <Textarea
                label=""
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
          </SettingsSection>

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

          <Group justify="flex-end" gap="sm" mt="md">
            <ButtonSecondaryOutline onClick={onClose}>Cancel</ButtonSecondaryOutline>
            <ButtonPrimaryLight loading={loading} onClick={() => void handleSave()}>
              Save
            </ButtonPrimaryLight>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
