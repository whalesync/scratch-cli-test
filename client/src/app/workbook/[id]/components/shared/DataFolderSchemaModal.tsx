'use client';

import { dataFolderApi } from '@/lib/api/data-folder';
import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import { ActionIcon, Box, Loader, Modal, Text, Tooltip, useMantineColorScheme } from '@mantine/core';
import type { DataFolder } from '@spinner/shared-types';
import CodeMirror from '@uiw/react-codemirror';
import { CheckIcon, CopyIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

interface DataFolderSchemaModalProps {
  opened: boolean;
  onClose: () => void;
  folder: DataFolder;
  mode?: 'view' | 'refresh';
}

export function DataFolderSchemaModal({ opened, onClose, folder, mode = 'view' }: DataFolderSchemaModalProps) {
  const [schema, setSchema] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const { colorScheme } = useMantineColorScheme();

  useEffect(() => {
    if (!opened) return;

    setLoading(true);
    setError(null);
    setSchema(null);
    setRefreshedAt(null);

    const fetchFn = mode === 'refresh' ? dataFolderApi.refreshSchema : dataFolderApi.getSchema;

    fetchFn(folder.id)
      .then((data) => {
        setSchema(data);
        setRefreshedAt(mode === 'refresh' ? new Date().toISOString() : null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load schema'))
      .finally(() => setLoading(false));
  }, [opened, folder.id, mode]);

  const lastUpdated = refreshedAt ?? folder.lastSchemaRefreshAt;
  const lastUpdatedLabel = lastUpdated ? `Last updated ${new Date(lastUpdated).toLocaleString()}` : null;

  const extensions = useMemo(() => [json(), EditorView.lineWrapping], []);
  const schemaText = useMemo(() => (schema ? JSON.stringify(schema, null, 2) : ''), [schema]);

  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(schemaText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [schemaText]);

  const title = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span>Schema: {folder.name}</span>
      {schema && (
        <Tooltip label={copied ? 'Copied!' : 'Copy to clipboard'} position="right">
          <ActionIcon size="sm" variant="subtle" color={copied ? 'green' : 'gray'} onClick={handleCopy}>
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          </ActionIcon>
        </Tooltip>
      )}
    </div>
  );

  return (
    <Modal opened={opened} onClose={onClose} title={title} size="xl">
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
          <Loader />
        </div>
      ) : error ? (
        <Text c="red" p="md">
          {error}
        </Text>
      ) : schema ? (
        <>
          <Box style={{ maxHeight: '70vh', overflow: 'auto' }}>
            <CodeMirror
              value={schemaText}
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
          {lastUpdatedLabel && (
            <Text c="dimmed" size="xs" pt="xs">
              {lastUpdatedLabel}
            </Text>
          )}
        </>
      ) : (
        <Text c="dimmed" p="md">
          No schema available for this data folder.
        </Text>
      )}
    </Modal>
  );
}
