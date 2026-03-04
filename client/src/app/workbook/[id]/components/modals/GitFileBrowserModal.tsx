import { GitFile, workbookApi } from '@/lib/api/workbook';
import { Anchor, Button, Code, Group, Loader, Modal, ScrollArea, Select, Stack, Text, ThemeIcon } from '@mantine/core';
import { WorkbookId } from '@spinner/shared-types';
import { ArrowUpIcon, FileIcon, FolderIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

interface GitFileBrowserModalProps {
  workbookId: WorkbookId;
  opened: boolean;
  onClose: () => void;
  connectorAccountId?: string;
}

export const GitFileBrowserModal = ({ workbookId, opened, onClose, connectorAccountId }: GitFileBrowserModalProps) => {
  const [branch, setBranch] = useState<'main' | 'dirty' | 'merge_base'>('main');
  const [currentPath, setCurrentPath] = useState('');
  const [currentFile, setCurrentFile] = useState<string | null>(null);
  const [files, setFiles] = useState<GitFile[]>([]);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Define data fetching logic
  const loadFolder = useCallback(
    async (path: string, br: string) => {
      setLoading(true);
      try {
        const list = await workbookApi.listRepoFiles(workbookId, br, path, connectorAccountId);
        setFiles(
          list.sort((a: GitFile, b: GitFile) => {
            if (a.type === b.type) return a.name.localeCompare(b.name);
            return a.type === 'directory' ? -1 : 1;
          }),
        );
        // Ensure file content is cleared when showing folder
        setFileContent(null);
      } catch (err) {
        console.error(err);
        setFiles([]);
      } finally {
        setLoading(false);
      }
    },
    [workbookId, connectorAccountId],
  );

  const loadFileContent = useCallback(
    async (path: string, filename: string, br: string) => {
      const filePath = path ? `${path}/${filename}` : filename;
      setLoading(true);
      try {
        const res = await workbookApi.getRepoFile(workbookId, filePath, br, connectorAccountId);
        setFileContent(res.content);
      } catch (err) {
        console.error(err);
        setFileContent(null); // Clear content if failed (e.g. file doesn't exist in this branch)
      } finally {
        setLoading(false);
      }
    },
    [workbookId, connectorAccountId],
  );

  // Main Effect: React to state changes (Navigation & Branch Switch)
  useEffect(() => {
    if (!opened) return;

    if (currentFile) {
      loadFileContent(currentPath, currentFile, branch);
    } else {
      loadFolder(currentPath, branch);
    }
  }, [opened, branch, currentPath, currentFile, loadFolder, loadFileContent]);

  // Reset state on Open
  useEffect(() => {
    if (opened) {
      setCurrentPath('');
      setCurrentFile(null);
      setFileContent(null);
      setBranch('main');
      // No need to call load functions here, the Main Effect will trigger due to state changes/isOpen
    }
  }, [opened]);

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
    <Modal title="Git Browser" opened={opened} onClose={onClose} size="lg">
      <Stack gap="md">
        <Group align="center" style={{ borderBottom: '1px solid var(--mantine-color-gray-3)', paddingBottom: '12px' }}>
          <Select
            value={branch}
            onChange={(val) => setBranch(val as 'main' | 'dirty' | 'merge_base')}
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
            /{currentPath} {currentFile ? `/${currentFile}` : ''}
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
    </Modal>
  );
};
