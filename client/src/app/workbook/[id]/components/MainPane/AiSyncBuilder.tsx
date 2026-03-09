'use client';

import { ButtonPrimarySolid } from '@/app/components/base/buttons';
import { Text12Regular } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { getHumanReadableErrorMessage } from '@/lib/api/error';
import { syncApi } from '@/lib/api/sync';
import { ActionIcon, Alert, Autocomplete, Code, Group, Modal, Stack, Textarea } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import type { AiGenerateSyncResponse, SyncId, WorkbookId } from '@spinner/shared-types';
import { Code as CodeIcon, Sparkles } from 'lucide-react';
import { useState } from 'react';

interface AiSyncBuilderProps {
  workbookId: WorkbookId;
  /** When provided, the component operates in edit mode (re-prompts an existing sync). */
  syncId?: SyncId;
  initialHistory?: string;
  onCreated: (result: AiGenerateSyncResponse) => void;
}

export function AiSyncBuilder({ workbookId, syncId, initialHistory, onCreated }: AiSyncBuilderProps) {
  const { isAdmin } = useScratchPadUser();
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState<string | null>('google/gemini-3.1-pro-preview');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyStr, setHistoryStr] = useState<string | null>(initialHistory || null);
  const [historyOpened, { open: openHistory, close: closeHistory }] = useDisclosure(false);

  const isEdit = !!syncId;

  const handleSubmit = async () => {
    if (!prompt.trim()) return;
    setError(null);
    setLoading(true);
    try {
      const result = isEdit
        ? await syncApi.aiEdit(workbookId, syncId, prompt.trim(), model || undefined)
        : await syncApi.aiGenerate(workbookId, prompt.trim(), model || undefined);

      if (result.history) {
        setHistoryStr(result.history);
      }

      onCreated(result);
      setPrompt('');
    } catch (err) {
      setError(getHumanReadableErrorMessage(err) ?? 'Failed to generate sync. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Stack gap="sm" align="stretch">
      {!isEdit && <Text12Regular c="dimmed">Or describe the sync you want in plain English:</Text12Regular>}
      <Textarea
        placeholder={
          isEdit
            ? 'e.g. Also map the description field, and use the slug as the matching key'
            : 'e.g. Sync all my data from Airtable to Webflow, except the users table'
        }
        value={prompt}
        onChange={(e) => setPrompt(e.currentTarget.value)}
        minRows={3}
        autosize
        disabled={loading}
      />
      {error && (
        <Alert color="red" variant="light">
          <Text12Regular>{error}</Text12Regular>
        </Alert>
      )}
      <Group justify="space-between" align="flex-end">
        <Group align="flex-end" style={{ flexGrow: 1 }}>
          <ButtonPrimarySolid
            // size="compact-sm"
            leftSection={<StyledLucideIcon Icon={Sparkles} size="sm" />}
            onClick={handleSubmit}
            loading={loading}
            disabled={!prompt.trim()}
          >
            {isEdit ? 'Update sync with AI' : 'Create sync with AI'}
          </ButtonPrimarySolid>

          {isAdmin && (
            <Autocomplete
              placeholder="Model Override"
              data={[
                'google/gemini-3.1-pro-preview',
                'google/gemini-3-flash-preview',
                'google/gemini-2.5-pro',
                'openai/o3-mini',
                'openai/gpt-4o',
                'anthropic/claude-3.5-sonnet',
              ]}
              filter={({ options }) => options}
              value={model || ''}
              onChange={setModel}
              w={260}
              size="sm"
              styles={{
                input: {
                  borderColor: 'var(--mantine-color-devTool-6)',
                  color: 'var(--mantine-color-devTool-9)',
                  backgroundColor: 'var(--mantine-color-devTool-0)',
                },
                dropdown: {
                  borderColor: 'var(--mantine-color-devTool-6)',
                },
              }}
            />
          )}
        </Group>

        {isAdmin && historyStr && (
          <ActionIcon
            color="var(--mantine-color-devTool-6)"
            variant="light"
            size="md"
            onClick={openHistory}
            title="View AI Prompt History"
          >
            <StyledLucideIcon Icon={CodeIcon} size="sm" />
          </ActionIcon>
        )}
      </Group>

      <Modal opened={historyOpened} onClose={closeHistory} title="AI Generation History" size="xl">
        <Code block>{historyStr}</Code>
      </Modal>
    </Stack>
  );
}
