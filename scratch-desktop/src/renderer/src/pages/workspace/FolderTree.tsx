import { Text12Regular, Text13Regular } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { Box, UnstyledButton } from '@mantine/core';
import { ChevronDown, ChevronRight, EllipsisVertical, Folder } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import type { WorkspaceConnection } from '../../types/local-files';
import { DataFolder } from '../../types/workspace';
import { ColumnDefinitionsModal } from './ColumnDefinitionsModal';
import classes from './FolderTree.module.css';
import { PullFoldersModal } from './PullFoldersModal';
import { LocalFolder } from './WorkspaceContent';

// ── Tree data structure ──

interface TreeNode {
  /** Display name for this segment (e.g. "Blog Posts") */
  name: string;
  /** The LocalFolder at this node, if it's a leaf */
  folder?: LocalFolder;
  /** Filesystem path for this node (leaf or intermediary) */
  fsPath?: string;
  /** Child nodes keyed by segment name, in insertion order */
  children: Map<string, TreeNode>;
}

interface PullRequest {
  title: string;
  dataFolderIds: string[];
  emptyStateMessage: string;
}

/** Walk a node to find any descendant leaf and return its filesystem path. */
function findDescendantLeaf(node: TreeNode): LocalFolder | undefined {
  if (node.folder) return node.folder;
  const children: TreeNode[] = Array.from(node.children.values());
  for (const child of children) {
    const found = findDescendantLeaf(child);
    if (found) return found;
  }
  return undefined;
}

/** Derive the filesystem path for an intermediary node by trimming trailing segments from a descendant leaf path. */
function assignFsPaths(node: TreeNode, depth: number): void {
  if (node.folder) {
    node.fsPath = node.folder.path;
  } else {
    const leaf = findDescendantLeaf(node);
    if (leaf) {
      // leaf.name has segments like "A/B/C", leaf.path is the full fs path for C.
      // This intermediary is at `depth` segments in, so strip the remaining segments from the end.
      const leafSegments = leaf.name.split('/');
      const segmentsToStrip = leafSegments.length - depth;
      if (segmentsToStrip > 0) {
        const parts = leaf.path.split('/');
        node.fsPath = parts.slice(0, parts.length - segmentsToStrip).join('/');
      }
    }
  }
  const children: TreeNode[] = Array.from(node.children.values());
  for (const child of children) {
    assignFsPaths(child, depth + 1);
  }
}

function buildTree(folders: LocalFolder[]): TreeNode {
  const root: TreeNode = { name: '', children: new Map() };

  for (const folder of folders) {
    const segments = folder.name.split('/');
    let current = root;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      let child = current.children.get(segment);
      if (!child) {
        child = { name: segment, children: new Map() };
        current.children.set(segment, child);
      }
      current = child;
    }

    // Attach the folder data to the leaf node
    current.folder = folder;
  }

  assignFsPaths(root, 0);
  return root;
}

function normalizeFolderPath(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

// ── Components ──

const INDENT_PX = 16;

const isMac = window.electron?.process?.platform === 'darwin';

interface FolderTreeNodeProps {
  node: TreeNode;
  depth: number;
  selectedFolderPath: string | null;
  onSelectFolder: (folderPath: string) => void;
  isDevToolsEnabled: boolean;
  onShowColumnDefs?: (folderPath: string) => void;
  dataFolderByLocalPath: Map<string, DataFolder>;
  dataFoldersByConnection: Map<string, DataFolder[]>;
  onRequestPull: (request: PullRequest) => void;
}

function FolderTreeNodeRow({
  node,
  depth,
  selectedFolderPath,
  onSelectFolder,
  isDevToolsEnabled,
  onShowColumnDefs,
  dataFolderByLocalPath,
  dataFoldersByConnection,
  onRequestPull,
}: FolderTreeNodeProps) {
  const hasChildren = node.children.size > 0;
  const [expanded, setExpanded] = useState(true);

  const handleClick = useCallback(() => {
    if (node.folder) {
      onSelectFolder(node.folder.path);
    } else if (hasChildren) {
      setExpanded((prev) => !prev);
    }
  }, [node.folder, hasChildren, onSelectFolder]);

  const showContextMenu = useCallback(
    (path: string) => {
      const localFolderPath = node.folder ? normalizeFolderPath(node.folder.name) : null;
      const mappedFolder = localFolderPath ? dataFolderByLocalPath.get(localFolderPath) : undefined;
      const connectionFolders = depth === 0 ? (dataFoldersByConnection.get(node.name) ?? []) : [];

      const items: Array<{
        id: string;
        label: string;
        type?: 'separator';
        submenu?: Array<{ id: string; label: string }>;
      }> = [];

      if (mappedFolder || (depth === 0 && connectionFolders.length > 0)) {
        items.push({ id: 'pull', label: mappedFolder ? 'Pull This Table' : 'Pull All Tables' });
        items.push({ id: 'pull-sep', label: '', type: 'separator' });
      }

      items.push(
        { id: 'reveal', label: isMac ? 'Open in Finder' : 'Open in Explorer' },
        { id: 'terminal', label: isMac ? 'Open in Terminal' : 'Open in PowerShell' },
      );

      if (isDevToolsEnabled && node.folder) {
        items.push({ id: 'sep', label: '', type: 'separator' });
        items.push({
          id: 'dev-tools',
          label: 'Dev Tools',
          submenu: [{ id: 'column-defs', label: 'Column Definitions…' }],
        });
      }

      window.scratchDesktop.showNativeContextMenu(items, (id) => {
        if (id === 'pull' && mappedFolder) {
          onRequestPull({
            title: `Pull Table — ${node.name}`,
            dataFolderIds: [mappedFolder.id],
            emptyStateMessage: 'No linked table found for this local folder.',
          });
        }
        if (id === 'pull' && !mappedFolder && depth === 0 && connectionFolders.length > 0) {
          onRequestPull({
            title: `Pull All Tables — ${node.name}`,
            dataFolderIds: connectionFolders.map((folder) => folder.id),
            emptyStateMessage: 'No linked tables found for this connection.',
          });
        }
        if (id === 'reveal') void window.scratchDesktop.showInFolder(path);
        if (id === 'terminal') void window.scratchDesktop.openInTerminal(path);
        if (id === 'column-defs') onShowColumnDefs?.(path);
      });
    },
    [
      dataFolderByLocalPath,
      dataFoldersByConnection,
      depth,
      isDevToolsEnabled,
      node.folder,
      node.name,
      onRequestPull,
      onShowColumnDefs,
    ],
  );

  const isSelected = node.folder != null && selectedFolderPath === node.folder.path;
  const sortedChildren = useMemo(() => Array.from(node.children.values()), [node.children]);
  const folderPath = node.fsPath ?? null;

  return (
    <>
      <UnstyledButton
        py={4}
        onClick={handleClick}
        onContextMenu={
          folderPath
            ? (e: React.MouseEvent) => {
                e.preventDefault();
                showContextMenu(folderPath);
              }
            : undefined
        }
        className={classes.folderRow}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          paddingLeft: 8 + depth * INDENT_PX,
          paddingRight: 8,
          backgroundColor: isSelected ? 'var(--highlight-fill)' : undefined,
        }}
      >
        {/* Chevron for expandable nodes */}
        {hasChildren ? (
          <Box
            component="span"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              setExpanded((prev) => !prev);
            }}
            style={{ display: 'flex', alignItems: 'center', flexShrink: 0, cursor: 'pointer' }}
          >
            <StyledLucideIcon Icon={expanded ? ChevronDown : ChevronRight} size="sm" c="var(--fg-muted)" />
          </Box>
        ) : (
          <Box style={{ width: 12, flexShrink: 0 }} />
        )}

        <StyledLucideIcon Icon={Folder} size="sm" c="var(--fg-secondary)" />

        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text13Regular c="var(--fg-primary)" truncate>
            {node.name}
          </Text13Regular>
        </Box>

        {node.folder != null && node.folder.fileCount > 0 && (
          <Text12Regular c="var(--fg-muted)" style={{ flexShrink: 0 }}>
            {node.folder.fileCount}
          </Text12Regular>
        )}

        {folderPath && (
          <Box
            component="span"
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              showContextMenu(folderPath);
            }}
            style={{
              display: 'flex',
              alignItems: 'center',
              flexShrink: 0,
              cursor: 'pointer',
              opacity: 0,
            }}
            className={classes.kebab}
          >
            <StyledLucideIcon Icon={EllipsisVertical} size="sm" c="var(--fg-muted)" />
          </Box>
        )}
      </UnstyledButton>

      {/* Render children when expanded */}
      {hasChildren && expanded && (
        <>
          {sortedChildren.map((child) => (
            <FolderTreeNodeRow
              key={child.name}
              node={child}
              depth={depth + 1}
              selectedFolderPath={selectedFolderPath}
              onSelectFolder={onSelectFolder}
              isDevToolsEnabled={isDevToolsEnabled}
              onShowColumnDefs={onShowColumnDefs}
              dataFolderByLocalPath={dataFolderByLocalPath}
              dataFoldersByConnection={dataFoldersByConnection}
              onRequestPull={onRequestPull}
            />
          ))}
        </>
      )}
    </>
  );
}

// ── Public component ──

interface FolderTreeProps {
  workspaceId: string;
  dataFolders: DataFolder[];
  workspaceConnections: WorkspaceConnection[];
  localFolders: LocalFolder[];
  selectedFolderPath: string | null;
  onSelectFolder: (folderPath: string) => void;
  workspacePath: string | null;
  isDevToolsEnabled: boolean;
  onDataRefresh: () => void;
}

export function FolderTree({
  workspaceId,
  dataFolders,
  workspaceConnections,
  localFolders,
  selectedFolderPath,
  onSelectFolder,
  workspacePath,
  isDevToolsEnabled,
  onDataRefresh,
}: FolderTreeProps) {
  const tree = useMemo(() => buildTree(localFolders), [localFolders]);
  const rootChildren = useMemo(() => Array.from(tree.children.values()), [tree]);
  const [columnDefsFolder, setColumnDefsFolder] = useState<string | null>(null);
  const [pullRequest, setPullRequest] = useState<PullRequest | null>(null);
  const connectionDirNameById = useMemo(
    () => new Map(workspaceConnections.map((connection) => [connection.id, connection.dirName])),
    [workspaceConnections],
  );

  const dataFolderByLocalPath = useMemo(() => {
    const byPath = new Map<string, DataFolder>();
    for (const folder of dataFolders) {
      if (!folder.path) continue;
      const connectionDir = folder.connectorAccountId ? connectionDirNameById.get(folder.connectorAccountId) : null;
      if (!connectionDir) continue;
      byPath.set(`${connectionDir}/${normalizeFolderPath(folder.path)}`, folder);
    }
    return byPath;
  }, [connectionDirNameById, dataFolders]);

  const dataFoldersByConnection = useMemo(() => {
    const byConnection = new Map<string, DataFolder[]>();
    for (const folder of dataFolders) {
      const connectionName = folder.connectorAccountId ? connectionDirNameById.get(folder.connectorAccountId) : null;
      if (!connectionName) continue;
      const group = byConnection.get(connectionName) ?? [];
      group.push(folder);
      byConnection.set(connectionName, group);
    }
    return byConnection;
  }, [connectionDirNameById, dataFolders]);

  const handleShowColumnDefs = useCallback((folderPath: string) => {
    setColumnDefsFolder(folderPath);
  }, []);

  return (
    <>
      {rootChildren.map((node) => (
        <FolderTreeNodeRow
          key={node.name}
          node={node}
          depth={0}
          selectedFolderPath={selectedFolderPath}
          onSelectFolder={onSelectFolder}
          isDevToolsEnabled={isDevToolsEnabled}
          onShowColumnDefs={handleShowColumnDefs}
          dataFolderByLocalPath={dataFolderByLocalPath}
          dataFoldersByConnection={dataFoldersByConnection}
          onRequestPull={setPullRequest}
        />
      ))}

      {columnDefsFolder && workspacePath && (
        <ColumnDefinitionsModal
          folderPath={columnDefsFolder}
          workspacePath={workspacePath}
          onClose={() => setColumnDefsFolder(null)}
        />
      )}

      {pullRequest && (
        <PullFoldersModal
          opened={true}
          onClose={() => setPullRequest(null)}
          localPath={workspacePath}
          workspaceId={workspaceId}
          title={pullRequest.title}
          dataFolderIds={pullRequest.dataFolderIds}
          emptyStateMessage={pullRequest.emptyStateMessage}
          onDataRefresh={onDataRefresh}
        />
      )}
    </>
  );
}
