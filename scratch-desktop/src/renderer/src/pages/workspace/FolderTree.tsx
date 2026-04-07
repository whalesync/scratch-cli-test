import { Text12Regular, Text13Regular } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { Box, UnstyledButton } from '@mantine/core';
import { ChevronDown, ChevronRight, Folder } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { LocalFolder } from './WorkspaceContent';

// ── Tree data structure ──

interface TreeNode {
  /** Display name for this segment (e.g. "Blog Posts") */
  name: string;
  /** The LocalFolder at this node, if it's a leaf */
  folder?: LocalFolder;
  /** Child nodes keyed by segment name, in insertion order */
  children: Map<string, TreeNode>;
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

  return root;
}

// ── Components ──

const INDENT_PX = 16;

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

  return (
    <>
      <UnstyledButton
        py={4}
        onClick={handleClick}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          paddingLeft: 8 + depth * INDENT_PX,
          paddingRight: 8,
          backgroundColor: isSelected ? 'var(--fg-divider)' : undefined,
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
