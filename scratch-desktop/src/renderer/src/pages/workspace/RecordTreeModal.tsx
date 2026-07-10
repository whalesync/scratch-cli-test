import type { RenderTreeNodePayload, TreeNodeData } from '@mantine/core';
import { Box, Center, Group, Loader, Modal, Stack, Tree, UnstyledButton, useTree } from '@mantine/core';
import { ChevronDown, ChevronRight, CornerDownRight, Database, FileText, Layers, ListTree } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { RecordTreeNode, RecordTreeResult } from '../../../../shared/record-tree-types';
import { Text12Regular, Text13Medium, Text13Regular } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { useWorkspaceUiStore } from '../../stores/workspace-ui-store';
import classes from './RecordTreeModal.module.css';

interface RecordTreeModalProps {
  opened: boolean;
  onClose: () => void;
  workspacePath: string;
  /** Workspace-relative `<connection>/<folder>` path of the folder. */
  folderRelPath: string;
  /** Service display name for the "Open in <service>" row action. */
  serviceDisplayName: string;
  /** Select a folder in the workspace sidebar (absolute filesystem path). */
  onSelectFolder: (folderPath: string) => void;
}

/**
 * Tree view of a folder whose records carry a parent pointer (the folder's
 * schema declares `recordTree` — e.g. Notion's Page Tree table). The tree is
 * derived on demand by `scratchmd record-tree`: nested pages, plus sibling data
 * folders embedded inside them (kind `folder`, e.g. a synced database living
 * inside a page).
 */
export function RecordTreeModal({
  opened,
  onClose,
  workspacePath,
  folderRelPath,
  serviceDisplayName,
  onSelectFolder,
}: RecordTreeModalProps) {
  const [result, setResult] = useState<RecordTreeResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!opened) return;
    let cancelled = false;
    setResult(null);
    setLoadError(null);
    window.scratchDesktop
      .recordTree(workspacePath, folderRelPath)
      .then((treeResult) => {
        if (!cancelled) setResult(treeResult);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [opened, workspacePath, folderRelPath]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      size="lg"
      centered
      title={
        <Group gap={8} align="center" wrap="nowrap">
          <StyledLucideIcon Icon={ListTree} size="sm" c="var(--fg-muted)" />
          <Text13Medium c="var(--fg-primary)">Page Tree</Text13Medium>
          {result && (
            <Text12Regular c="dimmed">
              ({result.totalRecords.toLocaleString()} page{result.totalRecords === 1 ? '' : 's'} total)
            </Text12Regular>
          )}
        </Group>
      }
    >
      {loadError ? (
        <Stack gap="xs">
          <Text13Regular c="var(--mantine-color-red-6)">Could not build the tree for this folder.</Text13Regular>
          <Text12Regular c="dimmed" style={{ whiteSpace: 'pre-wrap' }}>
            {loadError}
          </Text12Regular>
        </Stack>
      ) : !result ? (
        <Center py="xl">
          <Loader size="sm" />
        </Center>
      ) : result.roots.length === 0 ? (
        <Text13Regular c="dimmed">This folder has no records yet.</Text13Regular>
      ) : (
        <Stack gap="sm">
          {result.parseErrors.length > 0 && (
            <Text12Regular c="var(--mantine-color-orange-6)">
              {result.parseErrors.length} file{result.parseErrors.length === 1 ? '' : 's'} could not be read
            </Text12Regular>
          )}
          <Box style={{ maxHeight: '60vh', overflow: 'auto' }}>
            <RecordTreeView
              result={result}
              workspacePath={workspacePath}
              folderRelPath={folderRelPath}
              serviceDisplayName={serviceDisplayName}
              onSelectFolder={onSelectFolder}
              onClose={onClose}
            />
          </Box>
        </Stack>
      )}
    </Modal>
  );
}

interface NodeStats {
  directDescendants: number;
  allDescendants: number;
}

function RecordTreeView({
  result,
  workspacePath,
  folderRelPath,
  serviceDisplayName,
  onSelectFolder,
  onClose,
}: {
  result: RecordTreeResult;
  workspacePath: string;
  folderRelPath: string;
  serviceDisplayName: string;
  onSelectFolder: (folderPath: string) => void;
  onClose: () => void;
}) {
  const showRecord = useWorkspaceUiStore((state) => state.showRecord);
  const treeNodeData = useMemo(() => result.roots.map(toTreeNodeData), [result]);
  const { sourceNodeByValue, statsByValue } = useMemo(() => {
    const byValue = new Map<string, RecordTreeNode>();
    const stats = new Map<string, NodeStats>();
    const visit = (node: RecordTreeNode): number => {
      byValue.set(node.file, node);
      let allDescendants = node.children.length;
      for (const child of node.children) {
        allDescendants += visit(child);
      }
      stats.set(node.file, { directDescendants: node.children.length, allDescendants });
      return allDescendants;
    };
    result.roots.forEach(visit);
    return { sourceNodeByValue: byValue, statsByValue: stats };
  }, [result]);
  const rootValues = useMemo(() => new Set(result.roots.map((root) => root.file)), [result]);
  // Starts fully collapsed (useTree's default expanded state is empty).
  const tree = useTree();

  const openInService = (url: string) => {
    void window.scratchAuth.openExternal(url);
  };

  const openInScratch = (sourceNode: RecordTreeNode) => {
    if (sourceNode.kind === 'folder') {
      // Folder nodes carry their workspace-relative path in `file`.
      onSelectFolder(`${workspacePath}/${sourceNode.file}`);
    } else {
      onSelectFolder(`${workspacePath}/${folderRelPath}`);
      // Defer so it runs after the folder change's state reset (which clears
      // the record selection) — same pattern as the validation panel's
      // navigate-to-field.
      setTimeout(() => showRecord(sourceNode.file), 0);
    }
    onClose();
  };

  const renderNode = ({ node, expanded, hasChildren, elementProps }: RenderTreeNodePayload) => {
    const sourceNode = sourceNodeByValue.get(node.value);
    const stats = statsByValue.get(node.value);
    // Roots carry their parent kind (e.g. "workspace") so the view can say why
    // they sit at the top level; children need no annotation.
    const rootParentKind = rootValues.has(node.value) ? sourceNode?.parentKind : undefined;
    return (
      <Group gap={6} wrap="nowrap" py={2} {...elementProps} className={`${elementProps.className} ${classes.treeRow}`}>
        {hasChildren ? (
          <StyledLucideIcon Icon={expanded ? ChevronDown : ChevronRight} size="sm" c="var(--fg-muted)" />
        ) : (
          <Box style={{ width: 14, flexShrink: 0 }} />
        )}
        <StyledLucideIcon Icon={sourceNode?.kind === 'folder' ? Database : FileText} size="sm" c="var(--fg-muted)" />
        <Text13Regular style={{ whiteSpace: 'nowrap' }}>{node.label}</Text13Regular>
        {rootParentKind && <Text12Regular c="dimmed">· {rootParentKind}</Text12Regular>}
        {stats && stats.directDescendants > 0 && (
          <Group gap={4} wrap="nowrap" align="center">
            <StyledLucideIcon Icon={CornerDownRight} size="xs" c="var(--fg-muted)" />
            <Text12Regular c="dimmed">{stats.directDescendants}</Text12Regular>
            <StyledLucideIcon Icon={Layers} size="xs" c="var(--fg-muted)" />
            <Text12Regular c="dimmed">{stats.allDescendants}</Text12Regular>
          </Group>
        )}
        {sourceNode && (
          <Group gap={10} wrap="nowrap" className={classes.rowActions}>
            {sourceNode.url && (
              <UnstyledButton
                onClick={(event: React.MouseEvent) => {
                  event.stopPropagation();
                  if (sourceNode.url) openInService(sourceNode.url);
                }}
              >
                <Text12Regular c="dimmed">Open in {serviceDisplayName}</Text12Regular>
              </UnstyledButton>
            )}
            <UnstyledButton
              onClick={(event: React.MouseEvent) => {
                event.stopPropagation();
                openInScratch(sourceNode);
              }}
            >
              <Text12Regular c="dimmed">Open in Scratch</Text12Regular>
            </UnstyledButton>
          </Group>
        )}
      </Group>
    );
  };

  return <Tree data={treeNodeData} tree={tree} levelOffset={20} renderNode={renderNode} />;
}

function toTreeNodeData(node: RecordTreeNode): TreeNodeData {
  return {
    // The filename (or folder path for folder nodes) is unique within the
    // tree, unlike record names or the (possibly missing) record id.
    value: node.file,
    label: node.name,
    children: node.children.map(toTreeNodeData),
  };
}
