import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/components/base/buttons';
import { useConnectorAccounts } from '@/hooks/use-connector-accounts';
import { useDataFolders } from '@/hooks/use-data-folders';
import { connectorAccountsApi, isTableFullyLocked, type TableList } from '@/lib/connector-accounts-api';
import { dataFoldersApi } from '@/lib/data-folders-api';
import { Group, Loader, Modal, Stack, Switch, Text, Textarea, Tooltip } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { DataFolder, DataFolderOptions } from '@spinner/shared-types';
import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { ConnectorSettingField } from './connector-setting-field';

interface AdvancedFolderSettingsModalProps {
  opened: boolean;
  onClose: () => void;
  folder: DataFolder;
  workbookId: string;
}

/**
 * Extract field names from a stored table schema spec for the "Last modified field" picker.
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
      (node as Record<string, unknown>)['x-scratch-last-modified-field'] === true
    ) {
      autoDetected = name;
    }
  }
  names.sort((a, b) => a.localeCompare(b));
  return { names, autoDetected };
}

export function AdvancedFolderSettingsModal({ opened, onClose, folder, workbookId }: AdvancedFolderSettingsModalProps) {
  const { refresh: refreshDataFolders } = useDataFolders(workbookId);
  const { connectorAccounts } = useConnectorAccounts(workbookId);
  const [filter, setFilter] = useState('');
  const [readOnly, setReadOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [settingValues, setSettingValues] = useState<Record<string, unknown>>({});

  const connectorAccount = connectorAccounts.find((ca) => ca.id === folder.connectorAccountId);

  const { data: tableList, isLoading: isLoadingMetadata } = useSWR<TableList>(
    opened && folder.connectorAccountId ? ['tables', workbookId, folder.connectorAccountId] : null,
    () => connectorAccountsApi.listTables(workbookId, folder.connectorAccountId!),
    { revalidateOnFocus: false },
  );

  const supportsFilters = tableList?.supportsFilters ?? false;
  const advancedSettings = useMemo(() => tableList?.advancedSettings ?? [], [tableList?.advancedSettings]);

  const hasFieldSelect = useMemo(() => advancedSettings.some((s) => s.type === 'field-select'), [advancedSettings]);
  const { data: schemaData } = useSWR<Record<string, unknown>>(
    opened && hasFieldSelect ? ['folder-schema', folder.id] : null,
    () => dataFoldersApi.getSchema(folder.id),
    { revalidateOnFocus: false },
  );
  const { names: schemaFieldNames, autoDetected: autoDetectedField } = useMemo(
    () => extractSchemaFields(schemaData),
    [schemaData],
  );

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
      await dataFoldersApi.update(folder.id, {
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
                  ? `Scratch will not push changes to ${connectorAccount?.displayName ?? 'the remote'}`
                  : `Scratch will be able to push to ${connectorAccount?.displayName ?? 'the remote'}`}
              </Text>
            </Group>
          </Stack>

          {advancedSettings.map((setting) => (
            <ConnectorSettingField
              key={setting.key}
              setting={setting}
              value={settingValues[setting.key]}
              onChange={(val) => updateSettingValue(setting.key, val)}
              fieldOptions={schemaFieldNames}
              autoDetectedField={autoDetectedField}
            />
          ))}

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
