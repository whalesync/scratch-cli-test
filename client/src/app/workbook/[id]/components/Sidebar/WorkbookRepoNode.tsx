'use client';

import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Text12Medium, Text12Regular, TextMono12Regular } from '@/app/components/base/text';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { useWorkbookUIStore } from '@/stores/workbook-ui-store';
import { Box, Collapse, Group, Loader, Stack, UnstyledButton } from '@mantine/core';
import type { GitFile, WorkbookId } from '@spinner/shared-types';
import { ChevronDownIcon, ChevronRightIcon, FileJsonIcon, FolderIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCallback } from 'react';
import useSWR from 'swr';

const INDENT_PX = 10;

function sortGitFiles(files: GitFile[]): GitFile[] {
  return [...files].sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name);
    return a.type === 'directory' ? -1 : 1;
  });
}

// ============================================================================
// Scratch logo icon (matches the workbook picker icon)
// ============================================================================

function ScratchLogo({ size = 16 }: { size?: number }) {
  return (
    <Box
      style={{
        width: size,
        height: size,
        backgroundColor: 'var(--mantine-color-violet-4)',
        borderRadius: 3,
        flexShrink: 0,
        backgroundImage: 'url(/logo-color.svg)',
        backgroundSize: size + 4,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: 'center',
      }}
    />
  );
}

// ============================================================================
// Config Repo File Row (clickable, navigates to scratch file viewer)
// ============================================================================

interface ConfigRepoFileRowProps {
  name: string;
  path: string;
  depth: number;
  workbookId: WorkbookId;
}

function ConfigRepoFileRow({ name, path, depth, workbookId }: ConfigRepoFileRowProps) {
  const pathname = usePathname();
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  const href = `/workbook/${workbookId}/workbook-repo/${encodedPath}`;
  const isSelected = pathname.startsWith(`/workbook/${workbookId}/workbook-repo/${encodedPath}`);

  return (
    <Link href={href} style={{ textDecoration: 'none' }}>
      <UnstyledButton
        px="sm"
        py={3}
        style={{
          width: `calc(100% - ${INDENT_PX * depth}px)`,
          marginLeft: INDENT_PX * depth,
          backgroundColor: isSelected ? 'var(--mantine-color-gray-2)' : 'transparent',
        }}
        __vars={{ '--hover-bg': 'var(--mantine-color-gray-1)' }}
        styles={{ root: { '&:hover': { backgroundColor: 'var(--hover-bg)' } } }}
      >
        <Group gap={6} wrap="nowrap">
          <StyledLucideIcon Icon={FileJsonIcon} size="sm" c="var(--fg-secondary)" />
          <TextMono12Regular c="var(--fg-primary)" truncate>
            {name}
          </TextMono12Regular>
        </Group>
      </UnstyledButton>
    </Link>
  );
}

// ============================================================================
// Config Repo Directory Node (expandable)
// ============================================================================

interface ConfigRepoDirNodeProps {
  workbookId: WorkbookId;
  dirPath: string;
  name: string;
  depth: number;
  branch: string;
}

function WorkbookRepoRepoDirNode({ workbookId, dirPath, name, depth, branch }: ConfigRepoDirNodeProps) {
  const expandedNodes = useWorkbookUIStore((state) => state.expandedNodes);
  const toggleNode = useWorkbookUIStore((state) => state.toggleNode);

  const nodeId = `repo-dir-config-${dirPath}`;
  const isExpanded = expandedNodes.has(nodeId);

  const { data: files, isLoading } = useSWR(
    isExpanded ? ['config-repo-files', workbookId, branch, dirPath] : null,
    () => scratchApiClient.git.listRepoFiles(workbookId, branch, dirPath, undefined, true).then(sortGitFiles),
    { revalidateOnFocus: false },
  );

  const handleToggle = useCallback(() => {
    toggleNode(nodeId);
  }, [toggleNode, nodeId]);

  return (
    <>
      <UnstyledButton
        onClick={handleToggle}
        px="sm"
        py={3}
        style={{
          width: `calc(100% - ${INDENT_PX * depth}px)`,
          marginLeft: INDENT_PX * depth,
          backgroundColor: 'transparent',
        }}
        __vars={{ '--hover-bg': 'var(--mantine-color-gray-1)' }}
        styles={{ root: { '&:hover': { backgroundColor: 'var(--hover-bg)' } } }}
      >
        <Group gap={6} wrap="nowrap">
          <StyledLucideIcon Icon={isExpanded ? ChevronDownIcon : ChevronRightIcon} size="sm" c="var(--fg-secondary)" />
          <StyledLucideIcon Icon={FolderIcon} size="sm" c="var(--fg-secondary)" />
          <Text12Regular c="var(--fg-primary)" truncate>
            {name}
          </Text12Regular>
          {isLoading && <Loader size={10} />}
        </Group>
      </UnstyledButton>
      <Collapse in={isExpanded}>
        {!files && (
          <Box py={3} style={{ marginLeft: INDENT_PX * (depth + 1) }}>
            <Text12Regular c="var(--fg-muted)">Loading…</Text12Regular>
          </Box>
        )}
        {files?.map((f) =>
          f.type === 'directory' ? (
            <WorkbookRepoRepoDirNode
              key={f.path}
              workbookId={workbookId}
              dirPath={f.path}
              name={f.name}
              depth={depth + 1}
              branch={branch}
            />
          ) : (
            <ConfigRepoFileRow key={f.path} name={f.name} path={f.path} depth={depth + 1} workbookId={workbookId} />
          ),
        )}
      </Collapse>
    </>
  );
}

// ============================================================================
// WorkbookRepoNode (top-level node — browses the workbook repo)
// ============================================================================

interface WorkbookRepoNodeProps {
  workbookId: WorkbookId;
}

export function WorkbookRepoNode({ workbookId }: WorkbookRepoNodeProps) {
  const expandedNodes = useWorkbookUIStore((state) => state.expandedNodes);
  const toggleNode = useWorkbookUIStore((state) => state.toggleNode);

  const nodeId = 'workbook-repo';
  const isExpanded = expandedNodes.has(nodeId);
  const branch = 'main';

  const { data: files, isLoading } = useSWR(
    isExpanded ? ['config-repo-files', workbookId, branch, ''] : null,
    () => scratchApiClient.git.listRepoFiles(workbookId, branch, '', undefined, true).then(sortGitFiles),
    { revalidateOnFocus: false },
  );

  const handleToggle = useCallback(() => {
    toggleNode(nodeId);
  }, [toggleNode, nodeId]);

  return (
    <>
      <UnstyledButton
        onClick={handleToggle}
        px="sm"
        py={4}
        style={{
          width: '100%',
          backgroundColor: 'transparent',
        }}
        __vars={{ '--hover-bg': 'var(--mantine-color-gray-1)' }}
        styles={{ root: { '&:hover': { backgroundColor: 'var(--hover-bg)' } } }}
      >
        <Group gap={6} wrap="nowrap">
          <StyledLucideIcon Icon={isExpanded ? ChevronDownIcon : ChevronRightIcon} size="sm" c="var(--fg-secondary)" />
          <ScratchLogo size={16} />
          <Text12Medium c="var(--mantine-color-devTool-8)" truncate style={{ fontWeight: 600 }}>
            Workbook
          </Text12Medium>
          {isLoading && <Loader size={10} />}
        </Group>
      </UnstyledButton>
      <Collapse in={isExpanded}>
        <Stack gap={0} pl={INDENT_PX}>
          {!files && (
            <Box py={3} px="sm">
              <Text12Regular c="var(--fg-muted)">Loading…</Text12Regular>
            </Box>
          )}
          {files?.map((f) =>
            f.type === 'directory' ? (
              <WorkbookRepoRepoDirNode
                key={f.path}
                workbookId={workbookId}
                dirPath={f.path}
                name={f.name}
                depth={1}
                branch={branch}
              />
            ) : (
              <ConfigRepoFileRow key={f.path} name={f.name} path={f.path} depth={1} workbookId={workbookId} />
            ),
          )}
        </Stack>
      </Collapse>
    </>
  );
}
