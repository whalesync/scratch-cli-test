import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { Anchor, Button, Code, Group, Loader, Modal, ScrollArea, Select, Stack, Text, ThemeIcon } from '@mantine/core';
import { GitFile, WorkbookId } from '@spinner/shared-types';
import { ArrowUpIcon, FileIcon, FolderIcon } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';

const NO_GIT_FILES: GitFile[] = [];

interface GitFileBrowserModalProps {
  workbookId: WorkbookId;
  opened: boolean;
  onClose: () => void;
  connectorAccountId?: string;
  useConfigRepo?: boolean;
}

export const GitFileBrowserModal = ({
  workbookId,
  opened,
  onClose,
  connectorAccountId,
  useConfigRepo,
}: GitFileBrowserModalProps) => {
  // Mantine unmounts the modal body on close, so the browser below starts fresh (main branch, repo root) on every open.
  return (
    <Modal title="Git Browser" opened={opened} onClose={onClose} size="lg">
      <GitFileBrowser workbookId={workbookId} connectorAccountId={connectorAccountId} useConfigRepo={useConfigRepo} />
    </Modal>
  );
};

type GitBrowserBranch = 'main' | 'dirty' | 'merge_base';

function GitFileBrowser({
  workbookId,
  connectorAccountId,
  useConfigRepo,
}: Pick<GitFileBrowserModalProps, 'workbookId' | 'connectorAccountId' | 'useConfigRepo'>) {
  const [branch, setBranch] = useState<GitBrowserBranch>('main');
  const [currentPath, setCurrentPath] = useState('');
  const [currentFile, setCurrentFile] = useState<string | null>(null);

  const { data: files = NO_GIT_FILES, isLoading: folderLoading } = useSWR(
    SWR_KEYS.git.repoFolderListing(workbookId, branch, currentPath, connectorAccountId, useConfigRepo),
    async () => {
      const list = await scratchApiClient.git.listRepoFiles(
        workbookId,
        branch,
        currentPath,
        connectorAccountId,
        useConfigRepo,
      );
      return list.sort((a: GitFile, b: GitFile) => {
        if (a.type === b.type) return a.name.localeCompare(b.name);
        return a.type === 'directory' ? -1 : 1;
      });
    },
    { revalidateOnFocus: false, onError: (err) => console.error(err) },
  );

  const currentFilePath = currentFile ? (currentPath ? `${currentPath}/${currentFile}` : currentFile) : null;
  // A failed load (e.g. the file doesn't exist on this branch) leaves the content null, which falls back to the
  // folder listing below.
  const { data: fileContent = null, isLoading: fileLoading } = useSWR(
    currentFilePath
      ? SWR_KEYS.git.repoFileContent(workbookId, branch, currentFilePath, connectorAccountId, useConfigRepo)
      : null,
    async () => {
      if (!currentFilePath) return null;
      const res = await scratchApiClient.git.getRepoFile(
        workbookId,
        currentFilePath,
        branch,
        connectorAccountId,
        useConfigRepo,
      );
      return res.content;
    },
    { revalidateOnFocus: false, onError: (err) => console.error(err) },
  );

  const loading = currentFile ? fileLoading : folderLoading;

  const handleFolderClick = (folderName: string) => {
    const newPath = currentPath ? `${currentPath}/${folderName}` : folderName;
    setCurrentPath(newPath);
  };

  const handleFileClick = (fileName: string) => {
    setCurrentFile(fileName);
  };

  const handleGoUp = () => {
    if (currentFile) {
      setCurrentFile(null);
      return;
    }

    if (!currentPath) return;

    const parts = currentPath.split('/');
    parts.pop();
    const newPath = parts.join('/');
    setCurrentPath(newPath);
  };

  const renderContent = () => {
    if (currentFile && fileContent !== null) {
      return (
        <ScrollArea h={400} type="auto" offsetScrollbars>
          <Code block>{fileContent}</Code>
        </ScrollArea>
      );
    }

    if (currentFile && loading) {
      // While loading file content, show loader or nothing
      return null; // Or <Loader />
    }

    return (
      <Stack gap={4} h={400} style={{ overflowY: 'auto' }}>
        {files.length === 0 && !loading && (
          <Text c="dimmed" size="sm" p="xs">
            No files
          </Text>
        )}
        {files.map((f) => (
          <Group
            key={f.path}
            gap="xs"
            p={6}
            style={{
              cursor: 'pointer',
              borderRadius: '4px',
            }}
            // className="hover:bg-gray-100" // Tailwind not guaranteed, better use Mantine styling or sx
            // Mantine v7 prefers not using cx/classes for hover if not defined.
            // But original code had it. I'll keep it but adding maintainable style prop fallback
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--mantine-color-gray-1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
            onClick={() => {
              if (f.type === 'directory') {
                handleFolderClick(f.name);
              } else {
                handleFileClick(f.name);
              }
            }}
          >
            <ThemeIcon variant="light" color={f.type === 'directory' ? 'blue' : 'gray'} size="sm">
              {f.type === 'directory' ? <FolderIcon size={12} /> : <FileIcon size={12} />}
            </ThemeIcon>
            <Anchor
              component="button"
              type="button"
              size="sm"
              c={f.type === 'directory' ? 'blue' : 'dark'}
              underline="hover"
              onClick={(e) => {
                e.stopPropagation();
                if (f.type === 'directory') {
                  handleFolderClick(f.name);
                } else {
                  handleFileClick(f.name);
                }
              }}
            >
              {f.name}
            </Anchor>
          </Group>
        ))}
      </Stack>
    );
  };

  return (
    <Stack gap="md">
      <Group align="center" style={{ borderBottom: '1px solid var(--mantine-color-gray-3)', paddingBottom: '12px' }}>
        <Select
          value={branch}
          onChange={(val) => setBranch(val as GitBrowserBranch)}
          data={[
            { label: 'Main', value: 'main' },
            { label: 'Dirty', value: 'dirty' },
            { label: 'Merge Base', value: 'merge_base' },
          ]}
          w={130}
          size="xs"
          allowDeselect={false}
        />
        <Button
          leftSection={<ArrowUpIcon size={14} />}
          onClick={handleGoUp}
          disabled={!currentPath && !currentFile}
          size="xs"
          variant="default"
        >
          Up
        </Button>
        <Text size="sm" c="dimmed" style={{ fontFamily: 'monospace' }} truncate>
          {`/${currentPath}${currentFile ? `/${currentFile}` : ''}`}
        </Text>
      </Group>

      {loading ? (
        <Group justify="center" p="xl">
          <Loader size="sm" />
        </Group>
      ) : (
        renderContent()
      )}
    </Stack>
  );
}
