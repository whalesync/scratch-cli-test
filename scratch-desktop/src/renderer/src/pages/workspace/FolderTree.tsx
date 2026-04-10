import { Text12Regular, Text13Regular } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { Box, UnstyledButton } from '@mantine/core';
import { ChevronDown, ChevronRight, EllipsisVertical, Folder } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import classes from './FolderTree.module.css';
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

// ── Components ──

const INDENT_PX = 16;

const isMac = window.electron?.process?.platform === 'darwin';

function showFolderContextMenu(folderPath: string): void {
  window.scratchDesktop.showNativeContextMenu(
    [
      { id: 'reveal', label: isMac ? 'Open in Finder' : 'Open in Explorer' },
      { id: 'terminal', label: isMac ? 'Open in Terminal' : 'Open in PowerShell' },
    ],
    (id) => {
      if (id === 'reveal') void window.scratchDesktop.showInFolder(folderPath);
      if (id === 'terminal') void window.scratchDesktop.openInTerminal(folderPath);
    },
  );
}

interface FolderTreeNodeProps {
  node: TreeNode;
  depth: number;
  selectedFolderPath: string | null;
  onSelectFolder: (folderPath: string) => void;
}

function FolderTreeNodeRow({ node, depth, selectedFolderPath, onSelectFolder }: FolderTreeNodeProps) {
  const hasChildren = node.children.size > 0;
  const [expanded, setExpanded] = useState(true);

  const handleClick = useCallback(() => {
    if (node.folder) {
      onSelectFolder(node.folder.path);
    } else if (hasChildren) {
      setExpanded((prev) => !prev);
    }
  }, [node.folder, hasChildren, onSelectFolder]);

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
                showFolderContextMenu(folderPath);
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
              showFolderContextMenu(folderPath);
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
            />
          ))}
        </>
      )}
    </>
  );
}

// ── Public component ──

interface FolderTreeProps {
  localFolders: LocalFolder[];
  selectedFolderPath: string | null;
  onSelectFolder: (folderPath: string) => void;
}

export function FolderTree({ localFolders, selectedFolderPath, onSelectFolder }: FolderTreeProps) {
  const tree = useMemo(() => buildTree(localFolders), [localFolders]);
  const rootChildren = useMemo(() => Array.from(tree.children.values()), [tree]);

  return (
    <>
      {rootChildren.map((node) => (
        <FolderTreeNodeRow
          key={node.name}
          node={node}
          depth={0}
          selectedFolderPath={selectedFolderPath}
          onSelectFolder={onSelectFolder}
        />
      ))}
    </>
  );
}
