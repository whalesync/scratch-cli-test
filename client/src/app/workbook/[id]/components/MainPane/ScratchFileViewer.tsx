'use client';

import { Text13Regular, TextMono12Regular } from '@/app/components/base/text';
import { workbookApi } from '@/lib/api/workbook';
import { json } from '@codemirror/lang-json';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Badge, Box, Group, Stack, useMantineColorScheme } from '@mantine/core';
import type { WorkbookId } from '@spinner/shared-types';
import CodeMirror from '@uiw/react-codemirror';
import { useEffect, useMemo, useState } from 'react';

interface ScratchFileViewerProps {
  workbookId: WorkbookId;
  /** Full git path to the file, e.g. ".scratch/schema/MyTable/schema.json" */
  filePath: string;
  /** The connectorAccountId to scope the git repo */
  connectorAccountId?: string;
}

export function ScratchFileViewer({ workbookId, filePath, connectorAccountId }: ScratchFileViewerProps) {
  const { colorScheme } = useMantineColorScheme();
  const [content, setContent] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setIsLoading(true);
    setContent(null);
    setError(null);

    workbookApi
      .getRepoFile(workbookId, filePath, 'merge_base', connectorAccountId)
      .then((result) => {
        setContent(result?.content ?? '');
      })
      .catch(() => {
        setError('Failed to load file');
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [workbookId, filePath, connectorAccountId]);

  const fileName = useMemo(() => {
    const parts = filePath.split('/');
    return parts[parts.length - 1] || filePath;
  }, [filePath]);

  const extensions = useMemo(
    () => [json(), EditorView.lineWrapping, EditorView.editable.of(false), EditorState.readOnly.of(true)],
    [],
  );

  if (isLoading) {
    return (
      <Box p="xl" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Text13Regular c="dimmed">Loading file...</Text13Regular>
      </Box>
    );
  }

  if (error || content === null) {
    return (
      <Box p="xl" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Text13Regular c="dimmed">{error ?? 'File not found'}</Text13Regular>
      </Box>
    );
  }

  return (
    <Stack h="100%" gap={0}>
      <Group
        h={36}
        px="sm"
        justify="space-between"
        style={{
          borderBottom: '0.5px solid var(--fg-divider)',
          flexShrink: 0,
          backgroundColor: 'var(--bg-base)',
        }}
      >
        <Group gap="sm">
          <TextMono12Regular c="var(--fg-primary)">{fileName}</TextMono12Regular>
          <Badge size="xs" variant="light" color="gray">
            Read-only
          </Badge>
        </Group>
      </Group>

      <Box style={{ flex: 1, overflow: 'auto' }}>
        <CodeMirror
          value={content}
          extensions={extensions}
          theme={colorScheme === 'dark' ? 'dark' : 'light'}
          basicSetup={{
            lineNumbers: true,
            highlightActiveLineGutter: false,
            highlightSpecialChars: true,
            history: false,
            foldGutter: true,
            drawSelection: true,
            dropCursor: false,
            allowMultipleSelections: false,
            indentOnInput: false,
            syntaxHighlighting: true,
            bracketMatching: true,
            closeBrackets: false,
            autocompletion: false,
            rectangularSelection: false,
            crosshairCursor: false,
            highlightActiveLine: false,
            highlightSelectionMatches: true,
            closeBracketsKeymap: false,
            defaultKeymap: true,
            searchKeymap: true,
            historyKeymap: false,
            foldKeymap: true,
            completionKeymap: false,
            lintKeymap: false,
          }}
          style={{
            fontSize: '13px',
            height: '100%',
          }}
        />
      </Box>
    </Stack>
  );
}
