'use client';

import { Text13Regular } from '@/app/components/base/text';
import { useConnectionQuota } from '@/hooks/use-connection-quota';
import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import {
  ActionIcon,
  Box,
  Button,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core';
import CodeMirror from '@uiw/react-codemirror';
import { CheckIcon, CopyIcon, RefreshCwIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

interface ApiQuotaDialogProps {
  opened: boolean;
  onClose: () => void;
  workbookId: string;
  connectionId: string;
  connectionName: string;
}

/**
 * Dialog showing the raw API quota / rate-limit response for a connection.
 *
 * The fetch is gated on `opened` so we never request quota until the user
 * actually opens the dialog. Connectors that don't expose a quota endpoint
 * return `{ supported: false }`, in which case we render an "unsupported"
 * message instead of the JSON viewer.
 */
export function ApiQuotaDialog({ opened, onClose, workbookId, connectionId, connectionName }: ApiQuotaDialogProps) {
  const { colorScheme } = useMantineColorScheme();
  const { data, isLoading, error, refresh } = useConnectionQuota(workbookId, connectionId, opened);

  const extensions = useMemo(() => [json(), EditorView.lineWrapping], []);
  const quotaText = useMemo(() => (data && data.supported ? JSON.stringify(data.quota, null, 2) : ''), [data]);

  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(quotaText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [quotaText]);

  const errorMessage = error ? (error instanceof Error ? error.message : 'Failed to load API quota') : null;

  const title = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span>API Quota: {connectionName}</span>
      {data?.supported && (
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
      {isLoading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}>
          <Loader />
        </div>
      ) : errorMessage ? (
        <Stack gap="md" p="md">
          <Text c="red">{errorMessage}</Text>
          <Group>
            <Button size="xs" variant="light" leftSection={<RefreshCwIcon size={14} />} onClick={() => void refresh()}>
              Retry
            </Button>
          </Group>
        </Stack>
      ) : data?.supported === false ? (
        <Stack gap="xs" p="md">
          <Text13Regular>This connector does not expose API quota information.</Text13Regular>
          <Text c="dimmed" size="xs">
            Quota visibility is only available for connectors whose underlying APIs publish a rate-limit endpoint.
          </Text>
        </Stack>
      ) : data?.supported ? (
        <Stack gap="sm">
          <Box style={{ maxHeight: '70vh', overflow: 'auto' }}>
            <CodeMirror
              value={quotaText}
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
          <Group justify="space-between">
            <Text c="dimmed" size="xs">
              Snapshot fetched {new Date().toLocaleString()}
            </Text>
            <Button size="xs" variant="light" leftSection={<RefreshCwIcon size={14} />} onClick={() => void refresh()}>
              Refresh
            </Button>
          </Group>
        </Stack>
      ) : null}
    </Modal>
  );
}
