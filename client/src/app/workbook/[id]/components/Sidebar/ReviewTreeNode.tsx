'use client';

import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Text12Medium, Text12Regular } from '@/app/components/base/text';
import { useWorkbookUIStore } from '@/stores/workbook-ui-store';
import { fileMatchesFolder } from '@/utils/data-folder-helpers';
import { RouteUrls } from '@/utils/route-urls';
import { Box, Collapse, Group, Stack, Tooltip } from '@mantine/core';
import type {
  ConnectorAccount,
  DataFolder,
  DataFolderGroup,
  DataFolderOptions,
  FileDiffStatus,
  WorkbookId,
} from '@spinner/shared-types';
import { FolderIcon, FolderLockIcon, StickyNoteIcon } from 'lucide-react';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';
import { ChevronToggle, DirtyBadge, FileNameCell, INDENT_PX, TreeRow } from './tree-node-primitives';

const SCRATCH_GROUP_NAME = 'Scratch';
const REVIEW_FILES_PER_PAGE = 50;

// ============================================================================
// Intermediate folder helpers (duplicated from TreeNode — shared logic)
// ============================================================================

function getIntermediateSegments(folderPath: string, connectionName?: string): string[] {
  const segments = folderPath.replace(/^\//, '').split('/');
  const adjusted = connectionName && segments[0] === connectionName ? segments.slice(1) : segments;
  if (adjusted.length <= 1) return [];
  return adjusted.slice(0, -1);
}

interface FolderTreeNode {
  folders: DataFolder[];
  children: Map<string, FolderTreeNode>;
}

function buildFolderTree(folders: DataFolder[], groupName: string): FolderTreeNode {
  const root: FolderTreeNode = { folders: [], children: new Map() };

  for (const folder of folders) {
    const segments = getIntermediateSegments(
      folder.path ?? `/${groupName}/${folder.name}`,
      folder.connectorDisplayName ?? groupName,
    );
    let node = root;
    for (const seg of segments) {
      let child = node.children.get(seg);
      if (!child) {
        child = { folders: [], children: new Map() };
        node.children.set(seg, child);
      }
      node = child;
    }
    node.folders.push(folder);
  }

  return root;
}

// ============================================================================
// ReviewIntermediateFolderNode
// ============================================================================

interface ReviewIntermediateFolderNodeProps {
  name: string;
  nodeId: string;
  depth: number;
  children: React.ReactNode;
}

function ReviewIntermediateFolderNode({ name, nodeId, depth, children }: ReviewIntermediateFolderNodeProps) {
  const expandedNodes = useWorkbookUIStore((state) => state.expandedNodes);
  const toggleNode = useWorkbookUIStore((state) => state.toggleNode);
  const isExpanded = expandedNodes.has(nodeId);

  const handleToggle = useCallback(() => {
    toggleNode(nodeId);
  }, [toggleNode, nodeId]);

  return (
    <>
      {/* `selectable` reserves the 3px selection-indicator space so this row
          aligns horizontally with sibling ReviewTableNode rows. Intermediate
          folders never become selected — see TreeRowProps.selectable docs. */}
      <TreeRow onClick={handleToggle} indent={depth} selectable>
        <Group gap={6} wrap="nowrap">
          <ChevronToggle isExpanded={isExpanded} />
          <StyledLucideIcon Icon={FolderIcon} size="sm" c="var(--fg-secondary)" />
          <Text12Regular c="var(--fg-primary)" truncate>
            {name}
          </Text12Regular>
        </Group>
      </TreeRow>
      <Collapse in={isExpanded}>{children}</Collapse>
    </>
  );
}

// ============================================================================
// ReviewFolderTreeRenderer
// ============================================================================

interface ReviewFolderTreeRendererProps {
  tree: FolderTreeNode;
  depth: number;
  groupName: string;
  workbookId: WorkbookId;
  connectorAccountId: string | undefined;
  dirtyFilePaths: ReadonlyMap<string, FileDiffStatus>;
  idPrefix: string;
}

function ReviewFolderTreeRenderer({
  tree,
  depth,
  groupName,
  workbookId,
  connectorAccountId,
  dirtyFilePaths,
  idPrefix,
}: ReviewFolderTreeRendererProps) {
  // Same merge-and-sort approach as `FolderTreeRenderer` in TreeNode.tsx — see
  // the comment there for the rationale. Without this, intermediate folders
  // sort before terminal tables regardless of name, which produces a confusing
  // order for connectors that mix the two shapes (e.g. Affinity).
  type RenderEntry =
    | { kind: 'folder'; name: string; childNode: FolderTreeNode; index: number }
    | { kind: 'table'; name: string; folder: DataFolder; index: number };

  const entries: RenderEntry[] = [
    ...Array.from(tree.children.entries()).map(
      ([segName, childNode], index): RenderEntry => ({
        kind: 'folder',
        name: segName,
        childNode,
        index,
      }),
    ),
    ...tree.folders.map(
      (folder, index): RenderEntry => ({
        kind: 'table',
        name: folder.name,
        folder,
        index,
      }),
    ),
  ];
  entries.sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      {entries.map((entry) => {
        if (entry.kind === 'folder') {
          const childId = `${idPrefix}/${entry.name}`;
          const nodeId = `intermediate-${childId}`;
          const key = childId || `intermediate-${entry.index}`;
          return (
            <ReviewIntermediateFolderNode key={key} name={entry.name} nodeId={nodeId} depth={depth}>
              <ReviewFolderTreeRenderer
                tree={entry.childNode}
                depth={depth + 1}
                groupName={groupName}
                workbookId={workbookId}
                connectorAccountId={connectorAccountId}
                dirtyFilePaths={dirtyFilePaths}
                idPrefix={childId}
              />
            </ReviewIntermediateFolderNode>
          );
        }
        return (
          <ReviewTableNode
            key={entry.folder.id ?? `folder-${entry.index}`}
            folder={entry.folder}
            workbookId={workbookId}
            connectorAccountId={connectorAccountId}
            dirtyFilePaths={dirtyFilePaths}
            depth={depth}
          />
        );
      })}
    </>
  );
}

// ============================================================================
// ReviewConnectionNode
// ============================================================================

interface ReviewConnectionNodeProps {
  group: DataFolderGroup;
  workbookId: WorkbookId;
  connectorAccount?: ConnectorAccount;
  /** Connection that owns this group, or undefined for the Scratch (workbook config repo) group. */
  connectorAccountId: string | undefined;
  dirtyFilePaths: ReadonlyMap<string, FileDiffStatus>;
}

export function ReviewConnectionNode({
  group,
  workbookId,
  connectorAccount,
  connectorAccountId,
  dirtyFilePaths,
}: ReviewConnectionNodeProps) {
  const expandedNodes = useWorkbookUIStore((state) => state.expandedNodes);
  const toggleNode = useWorkbookUIStore((state) => state.toggleNode);

  const connectionId = connectorAccount?.id ?? group.dataFolders[0]?.connectorAccountId ?? group.name;
  const nodeId = `connection-${connectionId}`;
  const isExpanded = expandedNodes.has(nodeId);
  const isScratch = group.name === SCRATCH_GROUP_NAME;

  // Filter folders to only those with dirty files
  const visibleFolders = useMemo(() => {
    if (dirtyFilePaths.size === 0) return [];

    return group.dataFolders.filter((folder) => {
      if (!folder.path) return false;
      for (const dirtyPath of dirtyFilePaths.keys()) {
        if (fileMatchesFolder(folder.path, dirtyPath)) {
          return true;
        }
      }
      return false;
    });
  }, [dirtyFilePaths, group.dataFolders]);

  const folderTree = useMemo(() => buildFolderTree(visibleFolders, group.name), [visibleFolders, group.name]);

  // Hide connections with no dirty files
  if (visibleFolders.length === 0) {
    return null;
  }

  const handleToggle = () => toggleNode(nodeId);

  return (
    <>
      <TreeRow onClick={handleToggle}>
        <Group gap={6} wrap="nowrap" justify="space-between">
          <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
            <ChevronToggle isExpanded={isExpanded} />

            {isScratch ? (
              <StyledLucideIcon Icon={StickyNoteIcon} size="sm" c="var(--fg-secondary)" />
            ) : group.service ? (
              <ConnectorIcon connector={group.service} size={16} p={0} />
            ) : (
              <StyledLucideIcon Icon={FolderIcon} size="sm" c="var(--fg-secondary)" />
            )}

            <Text12Medium c="var(--fg-primary)" truncate style={{ fontWeight: 600 }}>
              {group.name}
            </Text12Medium>
          </Group>
        </Group>
      </TreeRow>

      <Collapse in={isExpanded}>
        <Stack gap={0} pl={INDENT_PX}>
          <ReviewFolderTreeRenderer
            tree={folderTree}
            depth={0}
            groupName={group.name}
            workbookId={workbookId}
            connectorAccountId={connectorAccountId}
            dirtyFilePaths={dirtyFilePaths}
            idPrefix={connectionId}
          />
        </Stack>
      </Collapse>
    </>
  );
}

// ============================================================================
// ReviewTableNode — shows folder with dirty count, no API calls
// ============================================================================

interface ReviewTableNodeProps {
  folder: DataFolder;
  workbookId: WorkbookId;
  /** Connection that owns this folder, or undefined for the Scratch group. */
  connectorAccountId: string | undefined;
  dirtyFilePaths: ReadonlyMap<string, FileDiffStatus>;
  /** Depth in the tree, controls left indentation. Mirrors `TableNode` in TreeNode.tsx. */
  depth: number;
}

function ReviewTableNode({ folder, workbookId, connectorAccountId, dirtyFilePaths, depth }: ReviewTableNodeProps) {
  const router = useRouter();
  const pathname = usePathname();
  const expandedNodes = useWorkbookUIStore((state) => state.expandedNodes);
  const toggleNode = useWorkbookUIStore((state) => state.toggleNode);

  const nodeId = `table-${folder.id}`;
  const isExpanded = expandedNodes.has(nodeId);

  const encodedFolderPath = (folder.path ?? folder.name)
    .replace(/^\//, '')
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
  const urlFolderPath = connectorAccountId
    ? `/workbook/${workbookId}/review/${encodeURIComponent(connectorAccountId)}/${encodedFolderPath}`
    : null;
  const isSelected = urlFolderPath !== null && pathname === urlFolderPath;

  // Build file list directly from dirtyFilePaths — no API call
  const dirtyFiles = useMemo(() => {
    if (!folder.path) return [];
    const files: { path: string; name: string; status: FileDiffStatus }[] = [];
    dirtyFilePaths.forEach((status, dirtyPath) => {
      if (fileMatchesFolder(folder.path!, dirtyPath)) {
        const parts = dirtyPath.split('/');
        files.push({ path: dirtyPath, name: parts[parts.length - 1], status });
      }
    });
    files.sort((a, b) => a.name.localeCompare(b.name));
    return files;
  }, [folder.path, dirtyFilePaths]);

  // Client-side pagination
  const [visibleCount, setVisibleCount] = useState(REVIEW_FILES_PER_PAGE);
  const displayedFiles = dirtyFiles.slice(0, visibleCount);
  const hasMore = dirtyFiles.length > visibleCount;

  const handleChevronClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      toggleNode(nodeId);
    },
    [toggleNode, nodeId],
  );

  const handleRowClick = useCallback(() => {
    if (urlFolderPath) router.push(urlFolderPath);
    if (!isExpanded) {
      toggleNode(nodeId);
    }
  }, [router, urlFolderPath, isExpanded, toggleNode, nodeId]);

  if (dirtyFiles.length === 0) return null;

  return (
    <>
      <TreeRow onClick={handleRowClick} indent={depth} selectable isSelected={isSelected}>
        <Group gap={6} wrap="nowrap" justify="space-between">
          <Group gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
            <ChevronToggle isExpanded={isExpanded} onClick={handleChevronClick} />
            {(folder.options as DataFolderOptions | null)?.readOnly ? (
              <Tooltip label="Read-only — pull only, never published back" position="right">
                <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                  <StyledLucideIcon Icon={FolderLockIcon} size={14} c="var(--fg-secondary)" />
                </span>
              </Tooltip>
            ) : (
              <StyledLucideIcon Icon={FolderIcon} size={14} c="var(--fg-secondary)" />
            )}
            <Text12Regular c="var(--fg-primary)" truncate>
              {folder.name}
            </Text12Regular>
          </Group>

          {!isExpanded && <DirtyBadge count={dirtyFiles.length} />}
        </Group>
      </TreeRow>

      <Collapse in={isExpanded}>
        <Stack gap={0} pl={INDENT_PX * 2} pr="sm">
          {displayedFiles.map((file) => (
            <ReviewFileNode key={file.path} file={file} connectorAccountId={connectorAccountId} />
          ))}

          {hasMore && (
            <Box py={4} px="sm" style={{ marginLeft: INDENT_PX }}>
              <Group gap={6} wrap="nowrap">
                <Box style={{ width: 6, flexShrink: 0 }} />
                <Text12Regular
                  c="var(--mantine-color-blue-6)"
                  style={{ cursor: 'pointer' }}
                  onClick={(e: React.MouseEvent) => {
                    e.stopPropagation();
                    setVisibleCount((prev) => prev + REVIEW_FILES_PER_PAGE);
                  }}
                >
                  Load more... ({dirtyFiles.length - visibleCount} remaining)
                </Text12Regular>
              </Group>
            </Box>
          )}
        </Stack>
      </Collapse>
    </>
  );
}

// ============================================================================
// ReviewFileNode — shows file name + dirty indicator, click navigates to review
// ============================================================================

interface ReviewFileNodeProps {
  file: { path: string; name: string; status: FileDiffStatus };
  /** Connection that owns this dirty file. Undefined means we cannot route to a review URL. */
  connectorAccountId: string | undefined;
}

function ReviewFileNode({ file, connectorAccountId }: ReviewFileNodeProps) {
  const params = useParams<{ id: string }>();
  const pathname = usePathname();
  const router = useRouter();

  const href = connectorAccountId
    ? RouteUrls.workbookReviewFileUrl(params.id, connectorAccountId, file.path)
    : null;
  const isSelected = href !== null && pathname === href;

  const handleFileClick = () => {
    if (href) router.push(href);
  };

  return (
    <TreeRow onClick={handleFileClick} indent={1} selectable isSelected={isSelected}>
      <FileNameCell name={file.name} status={file.status} isHidden={file.name.startsWith('.')} />
    </TreeRow>
  );
}
