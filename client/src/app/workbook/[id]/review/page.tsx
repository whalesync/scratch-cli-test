'use client';

import { Text12Medium, Text12Regular, Text13Medium, Text13Regular, Text16Regular } from '@/app/components/base/text';
import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { ConfirmDialog, useConfirmDialog } from '@/app/components/modals/ConfirmDialog';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { useDataFolders } from '@/hooks/use-data-folders';
import type { DirtyFile } from '@/hooks/use-dirty-files';
import { useDirtyFiles } from '@/hooks/use-dirty-files';
import { useFileByPath } from '@/hooks/use-file-path';
import { SWR_KEYS } from '@/lib/api/keys';
import { workbookApi } from '@/lib/api/workbook';
import { useActiveJobsStore } from '@/stores/active-jobs-store';
import { findDataFolderForFile } from '@/utils/data-folder-helpers';
import { RouteUrls } from '@/utils/route-urls';
import { json } from '@codemirror/lang-json';
import { unifiedMergeView } from '@codemirror/merge';
import { EditorView } from '@codemirror/view';
import { Box, Group, Loader, ScrollArea, Stack, Tooltip, UnstyledButton } from '@mantine/core';
import type { DataFolder, FileDiffStatus, Service, WorkbookId } from '@spinner/shared-types';
import CodeMirror from '@uiw/react-codemirror';
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloudUploadIcon,
  ExternalLinkIcon,
  RotateCcwIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { memo, useCallback, useMemo, useState } from 'react';
import { useSWRConfig } from 'swr';

// ── Constants ────────────────────────────────────────────────────────────────

const FILES_PER_PAGE = 100;

const STATUS_COLOR: Record<FileDiffStatus, string> = {
  added: 'var(--mantine-color-green-7)',
  deleted: 'var(--mantine-color-red-6)',
  modified: 'var(--mantine-color-orange-6)',
};

// ── Source grouping ──────────────────────────────────────────────────────────

interface SourceGroup {
  key: string;
  displayName: string;
  service: Service | null;
  files: DirtyFile[];
}

function groupFilesBySource(dirtyFiles: DirtyFile[], folders: DataFolder[]): SourceGroup[] {
  const groupMap = new Map<string, SourceGroup>();

  for (const file of dirtyFiles) {
    const folder = findDataFolderForFile(folders, file.path);
    const key = folder?.connectorDisplayName ?? '_ungrouped';
    const existing = groupMap.get(key);
    if (existing) {
      existing.files.push(file);
    } else {
      groupMap.set(key, {
        key,
        displayName: folder?.connectorDisplayName ?? 'Other',
        service: folder?.connectorService ?? null,
        files: [file],
      });
    }
  }

  const statusOrder: Record<string, number> = { added: 0, modified: 1, deleted: 2 };
  for (const group of groupMap.values()) {
    group.files.sort((a, b) => (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3));
  }

  return Array.from(groupMap.values());
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatFilePath(path: string) {
  const lastSlash = path.lastIndexOf('/');
  if (lastSlash === -1) return { folder: '', filename: path };
  return { folder: path.substring(0, lastSlash + 1), filename: path.substring(lastSlash + 1) };
}

function countByStatus(files: DirtyFile[]) {
  const result = { added: 0, modified: 0, deleted: 0 };
  for (const file of files) {
    if (file.status in result) result[file.status as keyof typeof result]++;
  }
  return result;
}

function computeDiffCounts(original: string | null, modified: string | null): { added: number; removed: number } {
  const origLines = (original ?? '').split('\n');
  const modLines = (modified ?? '').split('\n');
  const origSet = new Map<string, number>();
  for (const line of origLines) {
    origSet.set(line, (origSet.get(line) ?? 0) + 1);
  }
  const modSet = new Map<string, number>();
  for (const line of modLines) {
    modSet.set(line, (modSet.get(line) ?? 0) + 1);
  }

  let removed = 0;
  for (const [line, count] of origSet) {
    removed += Math.max(0, count - (modSet.get(line) ?? 0));
  }
  let added = 0;
  for (const [line, count] of modSet) {
    added += Math.max(0, count - (origSet.get(line) ?? 0));
  }

  return { added, removed };
}

// ── ReviewFileRow ────────────────────────────────────────────────────────────

interface ReviewFileRowProps {
  file: DirtyFile;
  workbookId: WorkbookId;
  folders: DataFolder[];
  onDiscard: (filePath: string) => void;
}

const ReviewFileRow = memo(function ReviewFileRow({ file, workbookId, folders, onDiscard }: ReviewFileRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);

  // Only fetch file content when expanded
  const { file: fileResponse, isLoading: fileLoading } = useFileByPath(workbookId, expanded ? file.path : null);

  const originalContent = fileResponse?.file?.originalContent ?? null;
  const modifiedContent = fileResponse?.file?.content ?? null;

  const { folder, filename } = formatFilePath(file.path);
  const href = RouteUrls.workbookReviewFileUrl(workbookId, file.path);
  const borderColor = STATUS_COLOR[file.status] ?? 'transparent';

  const diffCounts = useMemo(() => {
    if (!expanded || fileLoading || !fileResponse) return null;
    return computeDiffCounts(originalContent, modifiedContent);
  }, [expanded, fileLoading, fileResponse, originalContent, modifiedContent]);

  const extensions = useMemo(() => {
    if (!expanded || !fileResponse) return [];
    return [
      json(),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
      unifiedMergeView({
        original: originalContent ?? '',
        mergeControls: false,
        highlightChanges: true,
      }),
    ];
  }, [expanded, fileResponse, originalContent]);

  const handlePublish = useCallback(
    async (e: React.MouseEvent) => {
      e.stopPropagation();
      setIsPublishing(true);
      try {
        const dataFolder = findDataFolderForFile(folders, file.path);
        if (!dataFolder || !dataFolder.connectorAccountId) {
          ScratchpadNotifications.error({ message: 'Could not resolve connection for this file' });
          return;
        }
        const result = await workbookApi.planPublishV2(
          workbookId,
          dataFolder.connectorAccountId,
          true,
          undefined,
          file.path,
        );
        if (result?.jobId) {
          useActiveJobsStore.getState().trackJobIds([result.jobId]);
          useActiveJobsStore.getState().refreshJobs();
          ScratchpadNotifications.info({ message: 'Publishing file...' });
        }
      } catch (error) {
        console.debug('Failed to publish file:', error);
        ScratchpadNotifications.error({ message: 'Failed to publish file' });
      } finally {
        setIsPublishing(false);
      }
    },
    [workbookId, folders, file.path],
  );

  const handleDiscard = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onDiscard(file.path);
    },
    [file.path, onDiscard],
  );

  return (
    <Box style={{ borderBottom: '0.5px solid var(--fg-divider)' }}>
      <Group
        wrap="nowrap"
        gap="sm"
        pr="md"
        pl={6}
        py={7}
        className="review-file-row"
        style={{
          borderLeft: `3px solid ${borderColor}`,
          cursor: 'pointer',
        }}
        onClick={() => setExpanded((prev) => !prev)}
      >
        {/* Expand chevron */}
        <Box style={{ flexShrink: 0, color: 'var(--fg-muted)', display: 'flex' }}>
          {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </Box>

        {/* Path + filename */}
        <Group gap={0} wrap="nowrap" style={{ minWidth: 0, flexShrink: 1 }}>
          {folder && (
            <Text12Regular c="var(--fg-muted)" truncate style={{ flexShrink: 1 }}>
              {folder}
            </Text12Regular>
          )}
          <Text12Medium c="var(--fg-primary)" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
            {filename}
          </Text12Medium>
        </Group>

        <Box style={{ flex: 1 }} />

        {/* Diff stats when expanded */}
        {diffCounts && (diffCounts.added > 0 || diffCounts.removed > 0) && (
          <Text12Regular c="var(--fg-muted)" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
            {diffCounts.added > 0 && <span style={{ color: 'var(--mantine-color-green-7)' }}>+{diffCounts.added}</span>}
            {diffCounts.added > 0 && diffCounts.removed > 0 && ' / '}
            {diffCounts.removed > 0 && (
              <span style={{ color: 'var(--mantine-color-red-6)' }}>-{diffCounts.removed}</span>
            )}
          </Text12Regular>
        )}

        {/* Publish button (hover) */}
        <Box className="review-file-actions" style={{ flexShrink: 0, opacity: 0 }} onClick={handlePublish}>
          <Tooltip label="Publish" position="left">
            <UnstyledButton
              disabled={isPublishing}
              style={{ padding: 2, borderRadius: 3, display: 'flex', color: 'var(--mantine-color-green-7)' }}
            >
              {isPublishing ? <Loader size={12} /> : <CloudUploadIcon size={12} />}
            </UnstyledButton>
          </Tooltip>
        </Box>

        {/* Discard button (hover) */}
        <Box className="review-file-actions" style={{ flexShrink: 0, opacity: 0 }} onClick={handleDiscard}>
          <Tooltip label="Discard" position="left">
            <UnstyledButton
              style={{ padding: 2, borderRadius: 3, display: 'flex', color: 'var(--mantine-color-red-6)' }}
            >
              <RotateCcwIcon size={12} />
            </UnstyledButton>
          </Tooltip>
        </Box>

        {/* Open full view */}
        <Tooltip label="Open full diff" position="left">
          <Link
            href={href}
            onClick={(e: React.MouseEvent) => e.stopPropagation()}
            style={{ flexShrink: 0, display: 'flex', color: 'var(--fg-muted)', padding: 2 }}
          >
            <ExternalLinkIcon size={12} />
          </Link>
        </Tooltip>
      </Group>

      {/* Expanded: CodeMirror unified diff */}
      {expanded && (
        <Box mx="md" mb={4} style={{ border: '0.5px solid var(--fg-divider)', borderRadius: 3, overflow: 'hidden' }}>
          {fileLoading ? (
            <Box p="sm" style={{ display: 'flex', justifyContent: 'center' }}>
              <Loader size={14} />
            </Box>
          ) : (
            <CodeMirror
              key={file.path}
              value={modifiedContent ?? ''}
              extensions={extensions}
              editable={false}
              basicSetup={{
                lineNumbers: true,
                foldGutter: false,
                highlightActiveLine: false,
                highlightActiveLineGutter: false,
              }}
              style={{ fontSize: '12px' }}
            />
          )}
        </Box>
      )}
    </Box>
  );
});

// ── SourceGroupSection ───────────────────────────────────────────────────────

interface SourceGroupSectionProps {
  group: SourceGroup;
  workbookId: WorkbookId;
  folders: DataFolder[];
  onDiscard: (filePath: string) => void;
}

function SourceGroupSection({ group, workbookId, folders, onDiscard }: SourceGroupSectionProps) {
  const [visibleCount, setVisibleCount] = useState(FILES_PER_PAGE);
  const displayedFiles = group.files.slice(0, visibleCount);
  const hasMore = group.files.length > visibleCount;

  return (
    <Box>
      {/* Group header */}
      <Group
        gap="sm"
        px="md"
        py={8}
        style={{
          backgroundColor: 'var(--bg-panel)',
          borderBottom: '0.5px solid var(--fg-divider)',
          position: 'sticky',
          top: 0,
          zIndex: 1,
        }}
      >
        <ConnectorIcon connector={group.service} size={16} p={0} />
        <Text12Medium c="var(--fg-primary)">{group.displayName}</Text12Medium>
        <Text12Regular c="var(--fg-muted)">
          {group.files.length} {group.files.length === 1 ? 'file' : 'files'}
        </Text12Regular>
      </Group>

      {/* Files */}
      {displayedFiles.map((file) => (
        <ReviewFileRow key={file.path} file={file} workbookId={workbookId} folders={folders} onDiscard={onDiscard} />
      ))}

      {/* Load more */}
      {hasMore && (
        <Box py={6} px="md">
          <Text12Regular
            c="var(--mantine-color-blue-6)"
            style={{ cursor: 'pointer' }}
            onClick={() => setVisibleCount((prev) => prev + FILES_PER_PAGE)}
          >
            Load more... ({group.files.length - visibleCount} remaining)
          </Text12Regular>
        </Box>
      )}
    </Box>
  );
}

// ── Main page ────────────────────────────────────────────────────────────────

export default function ReviewPage() {
  const params = useParams<{ id: string }>();
  const workbookId = params.id as WorkbookId;
  const { dirtyFiles, isLoading, refresh } = useDirtyFiles(workbookId);
  const { folders } = useDataFolders(workbookId);
  const { mutate } = useSWRConfig();
  const { open: openConfirmDialog, dialogProps } = useConfirmDialog();

  const handleDiscard = useCallback(
    (filePath: string) => {
      openConfirmDialog({
        title: 'Discard Changes',
        message: `Discard changes to ${filePath.split('/').pop()}? This cannot be undone.`,
        confirmLabel: 'Discard',
        variant: 'danger',
        onConfirm: async () => {
          await workbookApi.discardChanges(workbookId, filePath);
          refresh();
          mutate(SWR_KEYS.dirtyFiles.hasDirty(workbookId));
        },
      });
    },
    [workbookId, openConfirmDialog, refresh, mutate],
  );

  const totalCounts = useMemo(() => countByStatus(dirtyFiles), [dirtyFiles]);
  const sourceGroups = useMemo(() => groupFilesBySource(dirtyFiles, folders), [dirtyFiles, folders]);

  if (isLoading) {
    return (
      <Box p="xl" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Group gap="xs">
          <Loader size={14} />
          <Text13Regular c="dimmed">Loading changes...</Text13Regular>
        </Group>
      </Box>
    );
  }

  if (dirtyFiles.length === 0) {
    return (
      <Box p="xl" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Stack align="center" gap="md">
          <StyledLucideIcon Icon={CheckCircle2Icon} size={40} c="var(--mantine-color-green-7)" />
          <Stack align="center" gap={4}>
            <Text16Regular c="var(--fg-secondary)">Nothing to review</Text16Regular>
            <Text13Regular c="dimmed">
              Push changes from the CLI, run a sync, or edit files to see them here
            </Text13Regular>
          </Stack>
        </Stack>
      </Box>
    );
  }

  return (
    <Stack h="100%" gap={0}>
      {/* Summary bar */}
      <Box
        px="md"
        py={10}
        style={{
          borderBottom: '0.5px solid var(--fg-divider)',
          flexShrink: 0,
        }}
      >
        <Group gap="md">
          <Text13Medium c="var(--fg-primary)">
            {dirtyFiles.length} {dirtyFiles.length === 1 ? 'file' : 'files'} changed
          </Text13Medium>
          {totalCounts.added > 0 && (
            <Text12Regular c="var(--mantine-color-green-7)">{totalCounts.added} added</Text12Regular>
          )}
          {totalCounts.modified > 0 && (
            <Text12Regular c="var(--mantine-color-orange-6)">{totalCounts.modified} modified</Text12Regular>
          )}
          {totalCounts.deleted > 0 && (
            <Text12Regular c="var(--mantine-color-red-6)">{totalCounts.deleted} deleted</Text12Regular>
          )}
        </Group>
      </Box>

      {/* File list grouped by source */}
      <ScrollArea style={{ flex: 1 }} type="auto">
        <Stack gap={0}>
          {sourceGroups.map((group) => (
            <SourceGroupSection
              key={group.key}
              group={group}
              workbookId={workbookId}
              folders={folders}
              onDiscard={handleDiscard}
            />
          ))}
        </Stack>
      </ScrollArea>

      <ConfirmDialog {...dialogProps} />

      <style>{`
        .review-file-row:hover {
          background-color: var(--bg-selected);
        }
        .review-file-row:hover .review-file-actions {
          opacity: 1 !important;
        }
      `}</style>
    </Stack>
  );
}
