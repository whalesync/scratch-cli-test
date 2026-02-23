'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { ModalWrapper } from '@/app/components/ModalWrapper';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { useDataFolders } from '@/hooks/use-data-folders';
import { dataFolderApi } from '@/lib/api/data-folder';
import { Checkbox, NumberInput, Stack, Textarea, TextInput } from '@mantine/core';
import type { DataFolder } from '@spinner/shared-types';
import { Service } from '@spinner/shared-types';
import { useEffect, useState } from 'react';

interface AdvancedFolderSettingsModalProps {
  opened: boolean;
  onClose: () => void;
  folder: DataFolder;
}

const FILTER_SUPPORTED_SERVICES = new Set([Service.NOTION, Service.AIRTABLE, Service.SUPABASE]);

export function AdvancedFolderSettingsModal({ opened, onClose, folder }: AdvancedFolderSettingsModalProps) {
  const { refresh: refreshDataFolders } = useDataFolders();
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(false);

  // Airtable options
  const [airtableView, setAirtableView] = useState('');

  // Notion options
  const [notionExcludePageContent, setNotionExcludePageContent] = useState(false);
  const [notionChildContentMaxDepth, setNotionChildContentMaxDepth] = useState<number | ''>('');

  const supportsFilter = folder.connectorService != null && FILTER_SUPPORTED_SERVICES.has(folder.connectorService);
  const isAirtable = folder.connectorService === Service.AIRTABLE;
  const isNotion = folder.connectorService === Service.NOTION;
  const hasPullOptions = isAirtable || isNotion;

  useEffect(() => {
    if (opened) {
      setFilter(folder.filter ?? '');
      const opts = folder.options ?? {};
      setAirtableView((opts.view as string) ?? '');
      setNotionExcludePageContent((opts.excludePageContent as boolean) ?? false);
      setNotionChildContentMaxDepth((opts.childContentMaxDepth as number) ?? '');
    }
  }, [opened, folder.filter, folder.options]);

  const buildOptions = (): Record<string, unknown> | undefined => {
    if (isAirtable) {
      const opts: Record<string, unknown> = {};
      if (airtableView.trim()) {
        opts.view = airtableView.trim();
      }
      return opts;
    }
    if (isNotion) {
      const opts: Record<string, unknown> = {};
      if (notionExcludePageContent) {
        opts.excludePageContent = true;
      }
      if (notionChildContentMaxDepth !== '' && notionChildContentMaxDepth >= 0) {
        opts.childContentMaxDepth = notionChildContentMaxDepth;
      }
      return opts;
    }
    return undefined;
  };

  const handleSave = async () => {
    setLoading(true);
    try {
      await dataFolderApi.update(folder.id, {
        filter: filter.trim() || null,
        ...(hasPullOptions && { options: buildOptions() }),
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
      <Stack>
        <Textarea
          label="Filter"
          description={
            supportsFilter
              ? 'Filter expression applied when pulling records from this table.'
              : 'Filters are only supported for Notion, Airtable, and Supabase connectors.'
          }
          placeholder={supportsFilter ? 'Enter filter expression...' : ''}
          value={filter}
          onChange={(e) => setFilter(e.currentTarget.value)}
          disabled={!supportsFilter}
          autosize
          minRows={3}
          maxRows={6}
        />

        {isAirtable && (
          <TextInput
            label="View"
            description="Airtable view ID to pull records from. Leave empty to pull all records."
            placeholder="Enter view ID..."
            value={airtableView}
            onChange={(e) => setAirtableView(e.currentTarget.value)}
          />
        )}

        {isNotion && (
          <>
            <Checkbox
              label="Exclude page content"
              description="Skip downloading the body content of Notion pages. This will increase download speed for notion tables."
              checked={notionExcludePageContent}
              onChange={(e) => setNotionExcludePageContent(e.currentTarget.checked)}
            />
            <NumberInput
              label="Child content max depth"
              description="Maximum depth of nested child blocks to include. Leave empty for default behavior."
              placeholder="e.g. 2"
              value={notionChildContentMaxDepth}
              onChange={(val) => setNotionChildContentMaxDepth(val === '' ? '' : Number(val))}
              min={0}
              max={10}
              hideControls
            />
          </>
        )}
      </Stack>
    </ModalWrapper>
  );
}
