'use client';

import { ButtonCompactDanger, ButtonCompactPrimary, ButtonCompactSecondary } from '@/app/components/base/buttons';
import { ConfirmDialog, useConfirmDialog } from '@/app/components/modals/ConfirmDialog';
import { useActiveWorkbook } from '@/hooks/use-active-workbook';
import { useDataFolders } from '@/hooks/use-data-folders';
import { useFileByPath } from '@/hooks/use-file-path';
import { workbookApi } from '@/lib/api/workbook';
import { findDataFolderForFile } from '@/utils/data-folder-helpers';
import { json } from '@codemirror/lang-json';
import { unifiedMergeView } from '@codemirror/merge';
import { Box, Group, SegmentedControl, Text, useMantineColorScheme } from '@mantine/core';
import type { WorkbookId } from '@spinner/shared-types';
import CodeMirror from '@uiw/react-codemirror';
import { CloudUploadIcon, RotateCcwIcon, SaveIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MergeEditor } from '../shared/MergeEditor';

type ViewMode = 'split' | 'unified';

interface ReviewFileViewerProps {
  workbookId: WorkbookId;
  filePath: string | null;
}

export function ReviewFileViewer({ workbookId, filePath }: ReviewFileViewerProps) {
  const router = useRouter();
  const { file: fileResponse, isLoading, updateFile, refreshFile } = useFileByPath(workbookId, filePath);
  const { publishFolders } = useActiveWorkbook();
  const { folders } = useDataFolders(workbookId);
  const { colorScheme } = useMantineColorScheme();

  // Editor content states
  const [content, setContent] = useState<string>('');
  const [savedContent, setSavedContent] = useState<string>('');
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);

  // View mode state - default to split (side-by-side)
  const [viewMode, setViewMode] = useState<ViewMode>('split');

  // Confirm dialog
  const { open: openConfirmDialog, dialogProps } = useConfirmDialog();

  const originalContent = fileResponse?.file?.originalContent ?? '';

  // Initialize content from file response
  const [isContentInitialized, setIsContentInitialized] = useState(false);
  const [initialContentLength, setInitialContentLength] = useState<number>(0);

  useEffect(() => {
    if (fileResponse?.file?.content !== undefined) {
      const fileContent = fileResponse.file.content ?? '';
      setContent(fileContent);
      setSavedContent(fileContent);
      setHasChanges(false);
      setInitialContentLength(fileContent.length);
      setIsContentInitialized(true);
    }
  }, [fileResponse]);

  const handleContentChange = useCallback(
    (newContent: string) => {
      setContent(newContent);
      setHasChanges(newContent !== savedContent);
    },
    [savedContent],
  );

  const handleSave = useCallback(async () => {
    if (!filePath || !hasChanges) return;

    setIsSaving(true);
    try {
      await updateFile({ content });
      setSavedContent(content);
      setHasChanges(false);
    } catch (error) {
      console.debug('Failed to save file:', error);
    } finally {
      setIsSaving(false);
    }
  }, [filePath, hasChanges, content, updateFile]);

  const handleDiscard = useCallback(() => {
    if (!filePath) return;

    openConfirmDialog({
      title: 'Discard Changes',
      message: 'Are you sure you want to discard changes to this file? This cannot be undone.',
      confirmLabel: 'Discard',
      variant: 'danger',
      onConfirm: async () => {
        setIsDiscarding(true);
        try {
          await workbookApi.discardChanges(workbookId, filePath);
          // Refresh the file data
          await refreshFile();
          // Navigate back to review page since this file is no longer modified
          router.push(`/workbook/${workbookId}/review`);
        } catch (error) {
          console.debug('Failed to discard changes:', error);
        } finally {
          setIsDiscarding(false);
        }
      },
    });
  }, [filePath, workbookId, refreshFile, router, openConfirmDialog]);

  const handlePublish = useCallback(async () => {
    if (!filePath) return;

    setIsPublishing(true);
    try {
      const folder = findDataFolderForFile(folders, filePath);

      if (!folder) {
        console.debug('Could not find data folder for file:', filePath);
        return;
      }

      // Publish via the data folder API which creates a job
      await publishFolders([folder.id]);

      // Refresh the file data
      await refreshFile();
      // Navigate back to review page since this file is now published
      router.push(`/workbook/${workbookId}/review`);
    } catch (error) {
      console.debug('Failed to publish file:', error);
    } finally {
      setIsPublishing(false);
    }
  }, [filePath, workbookId, refreshFile, router, folders, publishFolders]);

  // Keyboard shortcut: Cmd+S / Ctrl+S to save
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleSave]);

  const viewModeOptions = [
    { value: 'split', label: 'Side-by-side' },
    { value: 'unified', label: 'Inline' },
  ];

  const extensions = useMemo(() => {
    if (viewMode === 'unified') {
      return [
        json(),
        unifiedMergeView({
          original: originalContent,
          mergeControls: false,
          highlightChanges: true,
        }),
      ];
    }
    return [json()];
  }, [viewMode, originalContent]);

  // Force re-mount when switching modes
  const editorKey = useMemo(() => {
    return `${viewMode}-${filePath}`;
  }, [viewMode, filePath]);

  if (!filePath) {
    return (
      <Box p="xl" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Text c="dimmed">Select a modified file to review changes</Text>
      </Box>
    );
  }

  if (isLoading && !fileResponse && !isSaving) {
    return (
      <Box p="xl" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Text c="dimmed">Loading file...</Text>
      </Box>
    );
  }

  if ((!fileResponse && !isSaving) || !isContentInitialized) {
    if (!isContentInitialized && isLoading) {
      return (
        <Box p="xl" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
          <Text c="dimmed">Loading file...</Text>
        </Box>
      );
    }
    if (!fileResponse && !isSaving && !isLoading) {
      return (
        <Box p="xl" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
          <Text c="dimmed">File not found</Text>
        </Box>
      );
    }
  }

  return (
    <Box style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Toolbar */}
      <Group
        h={40}
        px="sm"
        justify="space-between"
        style={{
          borderBottom: '0.5px solid var(--fg-divider)',
          flexShrink: 0,
        }}
      >
        <Group gap="xs">
          <SegmentedControl
            size="xs"
            value={viewMode}
            onChange={(value) => setViewMode(value as ViewMode)}
            data={viewModeOptions}
          />
        </Group>
        <Group gap="xs">
          <ButtonCompactPrimary
            leftSection={<CloudUploadIcon size={12} />}
            onClick={handlePublish}
            loading={isPublishing}
          >
            Publish this file
          </ButtonCompactPrimary>
          <ButtonCompactDanger leftSection={<RotateCcwIcon size={12} />} onClick={handleDiscard} loading={isDiscarding}>
            Discard
          </ButtonCompactDanger>
          {hasChanges && (
            <ButtonCompactSecondary leftSection={<SaveIcon size={12} />} onClick={handleSave} loading={isSaving}>
              Save
            </ButtonCompactSecondary>
          )}
        </Group>
      </Group>

      {/* Diff Editor */}
      <Box style={{ flex: 1, overflow: 'auto' }}>
        {viewMode === 'split' ? (
          <MergeEditor
            key={`split-${originalContent?.length ?? 0}-${initialContentLength}`}
            original={originalContent}
            modified={content}
            onModifiedChange={handleContentChange}
          />
        ) : (
          <CodeMirror
            key={editorKey}
            value={content}
            onChange={handleContentChange}
            extensions={extensions}
            theme={colorScheme === 'dark' ? 'dark' : 'light'}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLineGutter: true,
              highlightSpecialChars: true,
              history: true,
              foldGutter: true,
              drawSelection: true,
              dropCursor: true,
              allowMultipleSelections: true,
              indentOnInput: true,
              syntaxHighlighting: true,
              bracketMatching: true,
              closeBrackets: true,
              autocompletion: true,
              rectangularSelection: true,
              crosshairCursor: true,
              highlightActiveLine: true,
              highlightSelectionMatches: true,
              closeBracketsKeymap: true,
              defaultKeymap: true,
              searchKeymap: true,
              historyKeymap: true,
              foldKeymap: true,
              completionKeymap: true,
              lintKeymap: true,
            }}
            style={{
              fontSize: '14px',
              height: '100%',
              border: 'none',
            }}
          />
        )}
      </Box>

      {/* Confirm Dialog */}
      <ConfirmDialog {...dialogProps} />
    </Box>
  );
}
