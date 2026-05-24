'use client';

import { connectorAccountsApi } from '@/lib/api/connector-accounts';
import { RevealCredentialsResponse } from '@/types/server-entities/connector-accounts';
import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import {
  ActionIcon,
  Alert,
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
import { notifications } from '@mantine/notifications';
import CodeMirror from '@uiw/react-codemirror';
import { AlertTriangleIcon, CheckIcon, CopyIcon, KeyRoundIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

interface BreakGlassCredentialsModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: string;
  connectionId: string;
  connectionName: string;
}

/**
 * Admin-only "break glass" reveal of a connection's decrypted credentials.
 *
 * The credentials are not fetched until the user explicitly clicks Reveal —
 * opening the modal alone does not pull plaintext over the wire. Each Reveal
 * click is audit-logged on the server.
 */
export function BreakGlassCredentialsModal({
  opened,
  onClose,
  workbookId,
  connectionId,
  connectionName,
}: BreakGlassCredentialsModalProps) {
  const { colorScheme } = useMantineColorScheme();
  const [data, setData] = useState<RevealCredentialsResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const extensions = useMemo(() => [json(), EditorView.lineWrapping], []);
  const jsonText = useMemo(
    () => (data ? JSON.stringify({ credentials: data.credentials, extras: data.extras }, null, 2) : ''),
    [data],
  );

  const handleReveal = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await connectorAccountsApi.revealCredentials(workbookId, connectionId);
      setData(response);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reveal credentials');
    } finally {
      setIsLoading(false);
    }
  }, [workbookId, connectionId]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(jsonText);
    setCopied(true);
    notifications.show({ title: 'Copied', message: 'Credentials copied to clipboard', color: 'green' });
    setTimeout(() => setCopied(false), 2000);
  }, [jsonText]);

  const handleClose = useCallback(() => {
    setData(null);
    setError(null);
    setCopied(false);
    onClose();
  }, [onClose]);

  const title = (
    <Group gap={10} align="center">
      <KeyRoundIcon size={16} />
      <span>Break Glass: {connectionName}</span>
      {data && (
        <Tooltip label={copied ? 'Copied!' : 'Copy to clipboard'} position="right">
          <ActionIcon size="sm" variant="subtle" color={copied ? 'green' : 'gray'} onClick={handleCopy}>
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          </ActionIcon>
        </Tooltip>
      )}
    </Group>
  );

  return (
    <Modal opened={opened} onClose={handleClose} title={title} size="xl">
      <Stack gap="md">
        <Alert icon={<AlertTriangleIcon size={16} />} color="red" variant="light">
          This will reveal the decrypted credentials for this connection. The reveal is recorded in the audit log. Only
          use this to help a customer debug a live connection.
        </Alert>

        {!data && !isLoading && (
          <Group justify="flex-end">
            <Button variant="default" onClick={handleClose}>
              Cancel
            </Button>
            <Button color="red" onClick={() => void handleReveal()}>
              Reveal Credentials
            </Button>
          </Group>
        )}

        {isLoading && (
          <Group justify="center" p="md">
            <Loader />
          </Group>
        )}

        {error && (
          <Stack gap="xs">
            <Text c="red">{error}</Text>
            <Group justify="flex-end">
              <Button variant="default" onClick={() => void handleReveal()}>
                Retry
              </Button>
            </Group>
          </Stack>
        )}

        {data && (
          <Stack gap="sm">
            <Box style={{ maxHeight: '60vh', overflow: 'auto' }}>
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
            <Group justify="flex-end">
              <Button onClick={handleClose}>Close</Button>
            </Group>
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
