'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { ModalWrapper } from '@/app/components/ModalWrapper';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { useDataFolders } from '@/hooks/use-data-folders';
import { connectorAccountsApi } from '@/lib/api/connector-accounts';
import { dataFolderApi } from '@/lib/api/data-folder';
import { SWR_KEYS } from '@/lib/api/keys';
import { useWorkbookUIStore } from '@/stores/workbook-ui-store';
import { isTableFullyLocked, TableList } from '@/types/server-entities/table-list';
import { Checkbox, Group, Loader, NumberInput, Stack, Switch, Text, Textarea, TextInput, Tooltip } from '@mantine/core';
import type { DataFolderOptions, ConnectorSettingDefinition, DataFolder } from '@spinner/shared-types';
import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';

interface AdvancedFolderSettingsModalProps {
  opened: boolean;
  onClose: () => void;
  folder: DataFolder;
}

function ConnectorSettingField({
  setting,
  value,
  onChange,
}: {
  setting: ConnectorSettingDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
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
      } else if (setting.type === 'string' && typeof value === 'string' && value.trim()) {
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

          {advancedSettings.map((setting) => (
            <ConnectorSettingField
              key={setting.key}
              setting={setting}
              value={settingValues[setting.key]}
              onChange={(val) => updateSettingValue(setting.key, val)}
            />
          ))}
        </Stack>
      )}
    </ModalWrapper>
  );
}
