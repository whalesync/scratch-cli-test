'use client';

import { Text12Regular, Text13Regular } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import { ActionIcon, Box, Loader, Modal, Tabs, Tooltip, useMantineColorScheme } from '@mantine/core';
import type { DataFolder, TableView } from '@spinner/shared-types';
import { ScratchpadApiError } from '@spinner/shared-types/api-client';
import CodeMirror from '@uiw/react-codemirror';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';

interface DataFolderSchemaModalProps {
  opened: boolean;
  onClose: () => void;
  folder: DataFolder;
  mode?: 'view' | 'refresh';
}

type DataFolderSchemaModalTab = 'table-spec' | 'default-view';

/** `GET /data-folder/:id/default-view` answers 404 when the folder has no stored default view. */
function isNoStoredDefaultViewError(error: unknown): boolean {
  return error instanceof ScratchpadApiError && error.statusCode === 404;
}

function formatJsonForDisplay(value: unknown): string {
  return value ? JSON.stringify(value, null, 2) : '';
}

/**
 * Shows a folder's stored table spec and default view, both read from the server (Postgres). In `refresh` mode the
 * table spec tab re-derives the spec from the service first, which also stores a new default view.
 */
export function DataFolderSchemaModal({ opened, onClose, folder, mode = 'view' }: DataFolderSchemaModalProps) {
  const [activeTab, setActiveTab] = useState<DataFolderSchemaModalTab>('table-spec');

  const fetchTableSpec =
    mode === 'refresh' ? scratchApiClient.dataFolders.refreshSchema : scratchApiClient.dataFolders.getSchema;
  const {
    data: tableSpec,
    isLoading: isTableSpecLoading,
    isValidating: isTableSpecValidating,
    error: tableSpecError,
  } = useSWR<Record<string, unknown>, Error>(opened ? SWR_KEYS.dataFolders.schema(folder.id, mode) : null, () =>
    fetchTableSpec(folder.id),
  );

  // A schema refresh rewrites the stored default view, so in `refresh` mode wait for it to finish before reading.
  const isDefaultViewReadable = opened && (mode === 'view' || (tableSpec !== undefined && !isTableSpecValidating));
  const {
    data: defaultView,
    isLoading: isDefaultViewLoading,
    error: defaultViewError,
  } = useSWR<TableView, Error>(
    isDefaultViewReadable ? SWR_KEYS.dataFolders.defaultView(folder.id, mode) : null,
    () => scratchApiClient.dataFolders.getDefaultView(folder.id),
    { shouldRetryOnError: (error) => !isNoStoredDefaultViewError(error) },
  );

  const lastUpdated = mode === 'refresh' && tableSpec ? new Date().toISOString() : new Date().toISOString();
  const lastUpdatedLabel = lastUpdated ? `Last updated ${new Date(lastUpdated).toLocaleString()}` : null;

  const tableSpecText = useMemo(() => formatJsonForDisplay(tableSpec), [tableSpec]);
  const defaultViewText = useMemo(() => formatJsonForDisplay(defaultView), [defaultView]);
  const activeTabText = activeTab === 'table-spec' ? tableSpecText : defaultViewText;

  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(activeTabText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [activeTabText]);

  const title = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span>Schema: {folder.name}</span>
      {activeTabText && (
        <Tooltip label={copied ? 'Copied!' : 'Copy to clipboard'} position="right">
          <ActionIcon size="sm" variant="subtle" color={copied ? 'green' : 'gray'} onClick={handleCopy}>
            <StyledLucideIcon Icon={copied ? CheckIcon : CopyIcon} size={14} />
          </ActionIcon>
        </Tooltip>
      )}
    </div>
  );

  return (
    <Modal opened={opened} onClose={onClose} title={title} size="xl">
      <Tabs
        value={activeTab}
        onChange={(tab) => {
          if (tab === 'table-spec' || tab === 'default-view') setActiveTab(tab);
        }}
      >
        <Tabs.List>
          <Tabs.Tab value="table-spec">Table spec</Tabs.Tab>
          <Tabs.Tab value="default-view">Default view</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="table-spec" pt="sm">
          {isTableSpecLoading ? (
            <CenteredLoader />
          ) : tableSpecError ? (
            <Text13Regular c="var(--mantine-color-red-6)" p="md">
              {tableSpecError.message || 'Failed to load schema'}
            </Text13Regular>
          ) : tableSpec ? (
            <>
              <ReadOnlyJsonViewer jsonText={tableSpecText} />
              {lastUpdatedLabel && (
                <Text12Regular c="dimmed" pt="xs">
                  {lastUpdatedLabel}
                </Text12Regular>
              )}
            </>
          ) : (
            <Text13Regular c="dimmed" p="md">
              No schema available for this data folder.
            </Text13Regular>
          )}
        </Tabs.Panel>

        <Tabs.Panel value="default-view" pt="sm">
          {tableSpecError && mode === 'refresh' ? (
            <Text13Regular c="dimmed" p="md">
              The schema refresh failed, so the default view was not updated.
            </Text13Regular>
          ) : isNoStoredDefaultViewError(defaultViewError) ? (
            <Text13Regular c="dimmed" p="md">
              No default view is stored for this table.
            </Text13Regular>
          ) : defaultViewError ? (
            <Text13Regular c="var(--mantine-color-red-6)" p="md">
              {defaultViewError.message || 'Failed to load default view'}
            </Text13Regular>
          ) : !isDefaultViewReadable || isDefaultViewLoading || !defaultView ? (
            <CenteredLoader />
          ) : (
            <ReadOnlyJsonViewer jsonText={defaultViewText} />
          )}
        </Tabs.Panel>
      </Tabs>
    </Modal>
  );
}

function CenteredLoader() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
      <Loader />
    </div>
  );
}

function ReadOnlyJsonViewer({ jsonText }: { jsonText: string }) {
  const { colorScheme } = useMantineColorScheme();
  const extensions = useMemo(() => [json(), EditorView.lineWrapping], []);

  return (
    <Box style={{ maxHeight: '70vh', overflow: 'auto' }}>
      <CodeMirror
        value={jsonText}
        extensions={extensions}
        theme={colorScheme === 'dark' ? 'dark' : 'light'}
        editable={false}
        basicSetup={{
          lineNumbers: true,
          foldGutter: true,
          highlightActiveLineGutter: false,
          highlightActiveLine: false,
          syntaxHighlighting: true,
          bracketMatching: true,
        }}
        style={{ fontSize: '13px' }}
      />
    </Box>
  );
}
