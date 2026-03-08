'use client';

import {
  Text12Medium,
  Text12Regular,
  Text13Medium,
  Text13Regular,
  TextMono12Regular,
} from '@/app/components/base/text';
import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { ConfirmDialog, useConfirmDialog } from '@/app/components/modals/ConfirmDialog';
import { useDataFolders } from '@/hooks/use-data-folders';
import type { DirtyFile } from '@/hooks/use-dirty-files';
import { useDirtyFiles } from '@/hooks/use-dirty-files';
import { filesApi } from '@/lib/api/files';
import { SWR_KEYS } from '@/lib/api/keys';
import { workbookApi } from '@/lib/api/workbook';
import { findDataFolderForFile } from '@/utils/data-folder-helpers';
import { RouteUrls } from '@/utils/route-urls';
import { Box, Group, Loader, ScrollArea, Stack, Tooltip, UnstyledButton } from '@mantine/core';
import type { DataFolder, FileDiffStatus, Service, WorkbookId } from '@spinner/shared-types';
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon, RotateCcwIcon } from 'lucide-react';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSWRConfig } from 'swr';

// ── Diff helpers ──────────────────────────────────────────────────────────────

interface DiffStats {
  linesChanged: number;
  firstOriginalLine: string | null;
  firstModifiedLine: string | null;
}

function computeDiffStats(original: string | null, modified: string | null): DiffStats {
  const origLines = (original ?? '').split('\n');
  const modLines = (modified ?? '').split('\n');

  let linesChanged = 0;
  let firstOriginalLine: string | null = null;
  let firstModifiedLine: string | null = null;
  const maxLen = Math.max(origLines.length, modLines.length);

  for (let i = 0; i < maxLen; i++) {
    const origLine = origLines[i] ?? undefined;
    const modLine = modLines[i] ?? undefined;
    if (origLine !== modLine) {
      linesChanged++;
      if (firstOriginalLine === null && firstModifiedLine === null) {
        firstOriginalLine = origLine?.trim() ?? null;
        firstModifiedLine = modLine?.trim() ?? null;
      }
    }
  }

  return { linesChanged, firstOriginalLine, firstModifiedLine };
}

/** Extract common prefix/suffix and the changed middle portions. */
function wordDiff(
  original: string,
  modified: string,
): { prefix: string; removed: string; added: string; suffix: string } {
  let prefixLen = 0;
  const minLen = Math.min(original.length, modified.length);
  while (prefixLen < minLen && original[prefixLen] === modified[prefixLen]) {
    prefixLen++;
  }

  let suffixLen = 0;
  while (
    suffixLen < minLen - prefixLen &&
    original[original.length - 1 - suffixLen] === modified[modified.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  return {
    prefix: original.substring(0, prefixLen),
    removed: original.substring(prefixLen, original.length - suffixLen),
    added: modified.substring(prefixLen, modified.length - suffixLen),
    suffix: original.substring(original.length - suffixLen),
  };
}

interface FileCacheEntry {
  loading: boolean;
  stats: DiffStats | null;
  originalContent: string | null;
  modifiedContent: string | null;
}

interface FileStatsCache {
  [path: string]: FileCacheEntry;
}

// ── Source grouping ───────────────────────────────────────────────────────────

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

// ── Inline diff component ───────────────────────────────────────────────────

const STATUS_COLOR: Record<FileDiffStatus, string> = {
  added: 'var(--mantine-color-green-7)',
  deleted: 'var(--mantine-color-red-6)',
  modified: 'var(--mantine-color-orange-6)',
};

const DIFF_REMOVED_STYLE: React.CSSProperties = {
  backgroundColor: 'rgba(248, 81, 73, 0.15)',
  borderRadius: 2,
  padding: '0 2px',
  textDecoration: 'line-through',
};

const DIFF_ADDED_STYLE: React.CSSProperties = {
  backgroundColor: 'rgba(63, 185, 80, 0.15)',
  borderRadius: 2,
  padding: '0 2px',
};

function InlineDiff({ status, stats }: { status: FileDiffStatus; stats: DiffStats | null }) {
  if (!stats) return null;

  if (status === 'added' && stats.firstModifiedLine) {
    return (
      <TextMono12Regular truncate component="span" c="var(--fg-secondary)">
        <span style={DIFF_ADDED_STYLE}>{stats.firstModifiedLine}</span>
      </TextMono12Regular>
    );
  }

  if (status === 'deleted' && stats.firstOriginalLine) {
    return (
      <TextMono12Regular truncate component="span" c="var(--fg-secondary)">
        <span style={DIFF_REMOVED_STYLE}>{stats.firstOriginalLine}</span>
      </TextMono12Regular>
    );
  }

  if (status === 'modified' && stats.firstOriginalLine && stats.firstModifiedLine) {
    const { prefix, removed, added, suffix } = wordDiff(stats.firstOriginalLine, stats.firstModifiedLine);
    return (
      <TextMono12Regular truncate component="span" c="var(--fg-secondary)">
        {prefix}
        {removed && <span style={DIFF_REMOVED_STYLE}>{removed}</span>}
        {added && <span style={DIFF_ADDED_STYLE}>{added}</span>}
        {suffix}
      </TextMono12Regular>
    );
  }

  return null;
}

// ── Expanded diff view ──────────────────────────────────────────────────────

interface DiffDisplayLine {
  type: 'context' | 'added' | 'removed' | 'separator';
  content: string;
}

const CONTEXT_LINES = 2;

function computeDisplayLines(original: string | null, modified: string | null): DiffDisplayLine[] {
  const origLines = (original ?? '').split('\n');
  const modLines = (modified ?? '').split('\n');
  const maxLen = Math.max(origLines.length, modLines.length);

  // Find which indices differ
  const changed = new Set<number>();
  for (let i = 0; i < maxLen; i++) {
    if ((origLines[i] ?? '') !== (modLines[i] ?? '')) {
      changed.add(i);
    }
  }

  if (changed.size === 0) return [];

  // Determine which indices to show (changed + context)
  const visible = new Set<number>();
  for (const idx of changed) {
    for (let c = Math.max(0, idx - CONTEXT_LINES); c <= Math.min(maxLen - 1, idx + CONTEXT_LINES); c++) {
      visible.add(c);
    }
  }

  const sorted = Array.from(visible).sort((a, b) => a - b);
  const lines: DiffDisplayLine[] = [];
  let lastIdx = -1;

  for (const idx of sorted) {
    if (lastIdx !== -1 && idx > lastIdx + 1) {
      lines.push({ type: 'separator', content: '' });
    }
    lastIdx = idx;

    if (changed.has(idx)) {
      const origLine = origLines[idx];
      const modLine = modLines[idx];
      if (origLine !== undefined && origLine !== '') {
        lines.push({ type: 'removed', content: origLine });
      }
      if (modLine !== undefined && modLine !== '') {
        lines.push({ type: 'added', content: modLine });
      }
    } else {
      // Context line — use whichever side has it
      const line = modLines[idx] ?? origLines[idx] ?? '';
      lines.push({ type: 'context', content: line });
    }
  }

  return lines;
}

const DIFF_LINE_STYLES: Record<DiffDisplayLine['type'], React.CSSProperties> = {
  context: {},
  added: { backgroundColor: 'rgba(63, 185, 80, 0.12)' },
  removed: { backgroundColor: 'rgba(248, 81, 73, 0.12)', textDecoration: 'line-through' },
  separator: { textAlign: 'center', color: 'var(--fg-muted)', padding: '2px 0' },
};

const DIFF_LINE_PREFIX: Record<DiffDisplayLine['type'], string> = {
  context: '  ',
  added: '+ ',
  removed: '- ',
  separator: '',
};

function ExpandedDiff({ original, modified }: { original: string | null; modified: string | null }) {
  const lines = useMemo(() => computeDisplayLines(original, modified), [original, modified]);

  if (lines.length === 0) return null;

  return (
    <Box
      mx="md"
      mb={4}
      style={{
        borderRadius: 3,
        border: '0.5px solid var(--fg-divider)',
        overflow: 'hidden',
        fontSize: 11,
        fontFamily: 'var(--mantine-font-family-monospace)',
        lineHeight: 1.6,
      }}
    >
      {lines.map((line, i) => {
        if (line.type === 'separator') {
          return (
            <Box key={i} px={8} style={DIFF_LINE_STYLES.separator}>
              ···
            </Box>
          );
        }

        return (
          <Box
            key={i}
            px={8}
            style={{
              ...DIFF_LINE_STYLES[line.type],
              whiteSpace: 'pre',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            <span style={{ color: 'var(--fg-muted)', userSelect: 'none' }}>{DIFF_LINE_PREFIX[line.type]}</span>
            {line.content}
          </Box>
        );
      })}
    </Box>
  );
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

// ── Main page ─────────────────────────────────────────────────────────────────

export default function ReviewPage() {
  const params = useParams<{ id: string }>();
  const workbookId = params.id as WorkbookId;
  const { dirtyFiles, isLoading, refresh } = useDirtyFiles(workbookId);
  const { folders } = useDataFolders(workbookId);
  const { mutate } = useSWRConfig();
  const [statsCache, setStatsCache] = useState<FileStatsCache>({});
  const [discardingPath, setDiscardingPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const { open: openConfirmDialog, dialogProps } = useConfirmDialog();

  const toggleExpanded = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Fetch file contents for diff stats
  useEffect(() => {
    if (dirtyFiles.length === 0) return;

    for (const file of dirtyFiles) {
      if (statsCache[file.path]) continue;

      setStatsCache((prev) => ({
        ...prev,
        [file.path]: { loading: true, stats: null, originalContent: null, modifiedContent: null },
      }));

      filesApi
        .getFileByPath(workbookId, file.path)
        .then((response) => {
          const orig = response.file.originalContent;
          const mod = response.file.content;
          const stats = computeDiffStats(orig, mod);
          setStatsCache((prev) => ({
            ...prev,
            [file.path]: { loading: false, stats, originalContent: orig, modifiedContent: mod },
          }));
        })
        .catch(() => {
          setStatsCache((prev) => ({
            ...prev,
            [file.path]: { loading: false, stats: null, originalContent: null, modifiedContent: null },
          }));
        });
    }
  }, [dirtyFiles, workbookId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleDiscardFile = useCallback(
    (filePath: string) => {
      openConfirmDialog({
        title: 'Discard Changes',
        message: `Discard changes to ${filePath.split('/').pop()}? This cannot be undone.`,
        confirmLabel: 'Discard',
        variant: 'danger',
        onConfirm: async () => {
          setDiscardingPath(filePath);
          try {
            await workbookApi.discardChanges(workbookId, filePath);
            refresh();
            mutate(SWR_KEYS.dirtyFiles.hasDirty(workbookId));
            setStatsCache((prev) => {
              const next = { ...prev };
              delete next[filePath];
              return next;
            });
          } finally {
            setDiscardingPath(null);
          }
        },
      });
    },
    [workbookId, openConfirmDialog, refresh, mutate],
  );

  const totalCounts = useMemo(() => countByStatus(dirtyFiles), [dirtyFiles]);
  const sourceGroups = useMemo(() => groupFilesBySource(dirtyFiles, folders), [dirtyFiles, folders]);

  const totalLinesChanged = useMemo(() => {
    let total = 0;
    for (const entry of Object.values(statsCache)) {
      if (entry.stats) total += entry.stats.linesChanged;
    }
    return total;
  }, [statsCache]);

  const allStatsLoaded =
    dirtyFiles.length > 0 && dirtyFiles.every((f) => statsCache[f.path] && !statsCache[f.path].loading);

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
        <Stack align="center" gap="xs">
          <Text13Regular c="dimmed">No unpublished changes</Text13Regular>
          <Text12Regular c="dimmed">Edits you make in Files will appear here for review</Text12Regular>
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
          {allStatsLoaded && totalLinesChanged > 0 && (
            <Text12Regular c="var(--fg-muted)">{totalLinesChanged} lines</Text12Regular>
          )}
        </Group>
      </Box>

      {/* File list grouped by source */}
      <ScrollArea style={{ flex: 1 }} type="auto">
        <Stack gap={0}>
          {sourceGroups.map((group) => (
            <Box key={group.key}>
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

              {/* Files in group */}
              {group.files.map((file) => {
                const { folder, filename } = formatFilePath(file.path);
                const cached = statsCache[file.path];
                const href = RouteUrls.workbookReviewFileUrl(workbookId, file.path);
                const isDiscarding = discardingPath === file.path;
                const borderColor = STATUS_COLOR[file.status] ?? 'transparent';
                const isExpanded = expandedPaths.has(file.path);

                return (
                  <Box key={file.path} style={{ borderBottom: '0.5px solid var(--fg-divider)' }}>
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
                      onClick={() => toggleExpanded(file.path)}
                    >
                      {/* Expand chevron */}
                      <Box style={{ flexShrink: 0, color: 'var(--fg-muted)', display: 'flex' }}>
                        {isExpanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                      </Box>

                      {/* Path + filename */}
                      <Group gap={0} wrap="nowrap" style={{ minWidth: 0, flexShrink: 1 }}>
                        {folder && (
                          <Text12Regular c="var(--fg-muted)" truncate style={{ flexShrink: 1 }}>
                            {folder}
                          </Text12Regular>
                        )}
                        <Text12Medium
                          c="var(--fg-primary)"
                          style={{
                            flexShrink: 0,
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {filename}
                        </Text12Medium>
                      </Group>

                      {/* Inline diff preview (hidden when expanded) */}
                      {!isExpanded && (
                        <Box style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
                          {cached?.loading ? (
                            <Loader size={10} />
                          ) : (
                            <InlineDiff status={file.status} stats={cached?.stats ?? null} />
                          )}
                        </Box>
                      )}
                      {isExpanded && <Box style={{ flex: 1 }} />}

                      {/* Line count */}
                      {cached?.stats && cached.stats.linesChanged > 0 && (
                        <Text12Regular c="var(--fg-muted)" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                          +{cached.stats.linesChanged}
                        </Text12Regular>
                      )}

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

                      {/* Discard (hover) */}
                      <Box
                        className="review-file-actions"
                        style={{ flexShrink: 0, opacity: 0 }}
                        onClick={(e: React.MouseEvent) => {
                          e.stopPropagation();
                          handleDiscardFile(file.path);
                        }}
                      >
                        <Tooltip label="Discard" position="left">
                          <UnstyledButton
                            disabled={isDiscarding}
                            style={{ padding: 2, borderRadius: 3, display: 'flex', color: 'var(--fg-muted)' }}
                          >
                            {isDiscarding ? <Loader size={12} /> : <RotateCcwIcon size={12} />}
                          </UnstyledButton>
                        </Tooltip>
                      </Box>
                    </Group>

                    {/* Expanded diff */}
                    {isExpanded && cached && !cached.loading && (
                      <ExpandedDiff original={cached.originalContent} modified={cached.modifiedContent} />
                    )}
                  </Box>
                );
              })}
            </Box>
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
