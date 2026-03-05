'use client';

import { ConfirmDialog, useConfirmDialog } from '@/app/components/modals/ConfirmDialog';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { useDataFolders } from '@/hooks/use-data-folders';
import { useFileByPath } from '@/hooks/use-file-path';
import { jobApi } from '@/lib/api/job';
import { workbookApi } from '@/lib/api/workbook';
import { useActiveJobsStore } from '@/stores/active-jobs-store';
import { useReviewToolbarStore } from '@/stores/review-toolbar-store';
import { findDataFolderForFile } from '@/utils/data-folder-helpers';
import { json } from '@codemirror/lang-json';
import { unifiedMergeView } from '@codemirror/merge';
import { Box, Text, useMantineColorScheme } from '@mantine/core';
import type { WorkbookId } from '@spinner/shared-types';
import CodeMirror from '@uiw/react-codemirror';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { MergeEditor } from '../shared/MergeEditor';

interface ReviewFileViewerProps {
  workbookId: WorkbookId;
  filePath: string | null;
}

export function ReviewFileViewer({ workbookId, filePath }: ReviewFileViewerProps) {
  const router = useRouter();
  const { file: fileResponse, isLoading, updateFile, refreshFile } = useFileByPath(workbookId, filePath);
  const { folders } = useDataFolders(workbookId);
  const { colorScheme } = useMantineColorScheme();

  // Editor content states
  const [content, setContent] = useState<string>('');
  const [savedContent, setSavedContent] = useState<string>('');
  const [hasChanges, setHasChanges] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDiscarding, setIsDiscarding] = useState(false);
  const [publishJobId, setPublishJobId] = useState<string | null>(null);
  const [isPublishSubmitting, setIsPublishSubmitting] = useState(false);
  const activeJobs = useActiveJobsStore((state) => state.activeJobs);
  const isJobActive = publishJobId !== null && activeJobs.some((job) => job.bullJobId === publishJobId);
  const isPublishing = isPublishSubmitting || isJobActive;

  // Navigate back to review page when publish job completes successfully
  const [wasJobActive, setWasJobActive] = useState(false);
  useEffect(() => {
    if (isJobActive) {
      setWasJobActive(true);
    } else if (wasJobActive && publishJobId) {
      setWasJobActive(false);
      const finishedJobId = publishJobId;
      setPublishJobId(null);
      jobApi.getJobsStatus([finishedJobId]).then((jobs) => {
        if (jobs[0]?.state === 'completed') {
          router.push(`/workbook/${workbookId}/review`);
        }
      });
    }
  }, [isJobActive, wasJobActive, publishJobId, workbookId, router]);

  // View mode from shared toolbar store
  const viewMode = useReviewToolbarStore((state) => state.viewMode);
  const setFileActions = useReviewToolbarStore((state) => state.setFileActions);
  const clearFileActions = useReviewToolbarStore((state) => state.clearFileActions);

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

    setIsPublishSubmitting(true);
    try {
      const folder = findDataFolderForFile(folders, filePath);

      if (!folder || !folder.connectorAccountId) {
        console.debug('Could not find data folder or connector account for file:', filePath);
        ScratchpadNotifications.error({ message: 'Could not resolve connection for this file' });
        return;
      }

      // Publish just this file directly using planPublishV2 with runAfterPlan=true and filePath properly set
      const result = await workbookApi.planPublishV2(workbookId, folder.connectorAccountId, true, undefined, filePath);

      if (result?.jobId) {
        setPublishJobId(result.jobId);
        useActiveJobsStore.getState().trackJobIds([result.jobId]);
        useActiveJobsStore.getState().refreshJobs();
        ScratchpadNotifications.info({ message: 'Initiated publish job for this file' });
      }

      // Refresh the file data
      await refreshFile();
    } catch (error) {
      console.debug('Failed to publish file:', error);
    } finally {
      setIsPublishSubmitting(false);
    }
  }, [filePath, workbookId, refreshFile, folders]);

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

  // Register file actions in the shared toolbar store
  useEffect(() => {
    setFileActions({
      onPublishFile: handlePublish,
      onDiscardFile: handleDiscard,
      onSaveFile: handleSave,
      isPublishing,
      isDiscarding,
      isSaving,
      hasChanges,
    });
  }, [setFileActions, handlePublish, handleDiscard, handleSave, isPublishing, isDiscarding, isSaving, hasChanges]);

  // Clear file actions on unmount
  useEffect(() => {
    return () => clearFileActions();
  }, [clearFileActions]);

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
      {/* Diff Editor */}
      <Box style={{ flex: 1, overflow: 'auto' }}>
        {viewMode === 'split' ? (
          <MergeEditor
            key={`split-${originalContent?.length ?? 0}-${initialContentLength}`}
            original={originalContent}
            modified={content}
            onModifiedChange={handleContentChange}
            connectionName={findDataFolderForFile(folders, filePath ?? '')?.connectorDisplayName ?? undefined}
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
