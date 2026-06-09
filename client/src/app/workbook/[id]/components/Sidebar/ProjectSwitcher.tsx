'use client';

import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Text13Medium, Text13Regular } from '@/app/components/base/text';
import { useDevTools } from '@/hooks/use-dev-tools';
import { useWorkbooks } from '@/hooks/use-workbooks';
import { usersApi } from '@/lib/api/users';
import { workbookApi } from '@/lib/api/workbook';
import { Box, Button, Group, Menu, Modal, Stack, TextInput, Textarea, Tooltip, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import type { WorkbookId, Workspace } from '@spinner/shared-types';
import { CheckIcon, ChevronDownIcon, PencilIcon, PlusIcon, UploadIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';

// Workspace colors for differentiation
const WORKSPACE_COLORS = [
  '#9BF9EB', // teal (default)
  'var(--mantine-color-violet-4)',
  'var(--mantine-color-blue-4)',
  'var(--mantine-color-green-4)',
  'var(--mantine-color-orange-4)',
  'var(--mantine-color-red-4)',
  'var(--mantine-color-pink-4)',
  'var(--mantine-color-cyan-4)',
  'var(--mantine-color-yellow-4)',
];

function getWorkspaceColor(index: number): string {
  return WORKSPACE_COLORS[index % WORKSPACE_COLORS.length];
}

// Scratch logo component for project icon
function ScratchLogo({ size = 16, backgroundColor = '#9BF9EB' }: { size?: number; backgroundColor?: string }) {
  return (
    <Box
      style={{
        width: size,
        height: size,
        backgroundColor,
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

interface ProjectSwitcherProps {
  currentWorkbook: Workspace;
}

export function ProjectSwitcher({ currentWorkbook }: ProjectSwitcherProps) {
  const router = useRouter();
  const { workbooks, createWorkbook, updateWorkbook } = useWorkbooks();
  const { isDevToolsEnabled } = useDevTools();
  const [menuOpened, setMenuOpened] = useState(false);

  // Rename modal state
  const [renameModalOpened, { open: openRenameModal, close: closeRenameModal }] = useDisclosure(false);
  const [workbookToRename, setWorkbookToRename] = useState<Workspace | null>(null);
  const [newName, setNewName] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);

  // Create modal state
  const [createModalOpened, { open: openCreateModal, close: closeCreateModal }] = useDisclosure(false);
  const [createName, setCreateName] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  // Import modal state
  const [importModalOpened, { open: openImportModal, close: closeImportModal }] = useDisclosure(false);
  const [importJson, setImportJson] = useState('');
  const [isImporting, setIsImporting] = useState(false);

  const handleSwitchProject = useCallback(
    (workbookId: WorkbookId) => {
      setMenuOpened(false);
      // Update last workbook in the background (don't await)
      usersApi.updateLastWorkbook(workbookId).catch(console.error);
      router.push(`/workbook/${workbookId}/files`);
    },
    [router],
  );

  const handleOpenRename = useCallback(
    (e: React.MouseEvent, workbook: Workspace) => {
      e.stopPropagation();
      setWorkbookToRename(workbook);
      setNewName(workbook.name ?? '');
      setMenuOpened(false);
      openRenameModal();
    },
    [openRenameModal],
  );

  const handleRename = useCallback(async () => {
    if (!workbookToRename || !newName.trim()) return;

    setIsRenaming(true);
    try {
      await updateWorkbook(workbookToRename.id, { name: newName.trim() });
      closeRenameModal();
      setWorkbookToRename(null);
    } catch (error) {
      console.error('Failed to rename workbook:', error);
    } finally {
      setIsRenaming(false);
    }
  }, [workbookToRename, newName, updateWorkbook, closeRenameModal]);

  const handleOpenCreate = useCallback(() => {
    setCreateName('');
    setMenuOpened(false);
    openCreateModal();
  }, [openCreateModal]);

  const handleCreate = useCallback(async () => {
    if (!createName.trim()) return;

    setIsCreating(true);
    try {
      const newWorkbook = await createWorkbook({ name: createName.trim() });
      closeCreateModal();
      router.push(`/workbook/${newWorkbook.id}/files`);
    } catch (error) {
      console.error('Failed to create workbook:', error);
    } finally {
      setIsCreating(false);
    }
  }, [createName, createWorkbook, closeCreateModal, router]);

  const handleOpenImport = useCallback(() => {
    setImportJson('');
    setMenuOpened(false);
    openImportModal();
  }, [openImportModal]);

  const handleImport = useCallback(async () => {
    if (!importJson.trim()) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(importJson);
    } catch {
      notifications.show({ title: 'Error', message: 'Invalid JSON', color: 'red' });
      return;
    }

    setIsImporting(true);
    try {
      const result = await workbookApi.importWorkbookJson(parsed);
      closeImportModal();
      router.push(`/workbook/${result.workbookId}/files`);
    } catch (error) {
      notifications.show({ title: 'Error', message: 'Failed to import workspace', color: 'red' });
      console.error('Failed to import workbook:', error);
    } finally {
      setIsImporting(false);
    }
  }, [importJson, closeImportModal, router]);

  // Find the index of the current workbook in the list for color assignment
  const currentIndex = workbooks?.findIndex((w) => w.id === currentWorkbook.id) ?? 0;

  return (
    <>
      <Menu opened={menuOpened} onChange={setMenuOpened} position="bottom-start" width={280}>
        <Menu.Target>
          <UnstyledButton
            px="sm"
            h={40}
            style={{
              width: '100%',
              borderBottom: '1px solid var(--fg-divider)',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Group justify="space-between" wrap="nowrap">
              <Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                <ScratchLogo size={21} backgroundColor={getWorkspaceColor(currentIndex)} />
                <Text13Medium truncate style={{ flex: 1 }}>
                  {currentWorkbook.name ?? 'Untitled'}
                </Text13Medium>
              </Group>
              <StyledLucideIcon Icon={ChevronDownIcon} size="sm" c="var(--fg-secondary)" />
            </Group>
          </UnstyledButton>
        </Menu.Target>

        <Menu.Dropdown>
          {/* Workspace list */}
          {workbooks?.map((workbook, index) => {
            const isCurrent = workbook.id === currentWorkbook.id;

            return (
              <Menu.Item
                key={workbook.id}
                onClick={() => handleSwitchProject(workbook.id)}
                style={{
                  backgroundColor: isCurrent ? 'var(--bg-selected)' : undefined,
                }}
              >
                <Group justify="space-between" wrap="nowrap" style={{ width: '100%' }}>
                  <Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                    <ScratchLogo size={21} backgroundColor={getWorkspaceColor(index)} />
                    <Text13Regular truncate style={{ flex: 1 }}>
                      {workbook.name ?? 'Untitled'}
                    </Text13Regular>
                  </Group>
                  <Group gap={4} wrap="nowrap">
                    {isCurrent && <StyledLucideIcon Icon={CheckIcon} size="sm" c="var(--fg-primary)" />}
                    <Tooltip label="Rename" position="top">
                      <Box
                        onClick={(e: React.MouseEvent) => handleOpenRename(e, workbook)}
                        style={{
                          cursor: 'pointer',
                          padding: 2,
                          borderRadius: 4,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <PencilIcon size={14} />
                      </Box>
                    </Tooltip>
                  </Group>
                </Group>
              </Menu.Item>
            );
          })}

          <Menu.Divider />

          {/* New Workspace */}
          <Menu.Item onClick={handleOpenCreate} leftSection={<PlusIcon size={14} />}>
            <Text13Regular c="var(--fg-secondary)">New Workspace</Text13Regular>
          </Menu.Item>

          {isDevToolsEnabled && (
            <>
              <Menu.Divider />
              <Menu.Label>Debug Tools</Menu.Label>
              <Menu.Item data-devtool onClick={handleOpenImport} leftSection={<UploadIcon size={14} />}>
                Import Workspace from JSON
              </Menu.Item>
            </>
          )}
        </Menu.Dropdown>
      </Menu>

      {/* Rename Modal */}
      <Modal opened={renameModalOpened} onClose={closeRenameModal} title="Rename Workspace" size="sm" centered>
        <Stack gap="md">
          <TextInput
            label="Workspace Name"
            placeholder="My Workspace"
            value={newName}
            onChange={(e) => setNewName(e.currentTarget.value)}
            data-autofocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleRename();
              }
            }}
          />
          <Group justify="flex-end" gap="sm">
            <Button variant="subtle" color="gray" onClick={closeRenameModal}>
              Cancel
            </Button>
            <Button onClick={handleRename} loading={isRenaming} disabled={!newName.trim()}>
              Rename
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Create Modal */}
      <Modal opened={createModalOpened} onClose={closeCreateModal} title="New Workspace" size="sm" centered>
        <Stack gap="md">
          <TextInput
            label="Workspace Name"
            placeholder="My Workspace"
            value={createName}
            onChange={(e) => setCreateName(e.currentTarget.value)}
            data-autofocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                handleCreate();
              }
            }}
          />
          <Group justify="flex-end" gap="sm">
            <Button variant="subtle" color="gray" onClick={closeCreateModal}>
              Cancel
            </Button>
            <Button onClick={handleCreate} loading={isCreating} disabled={!createName.trim()}>
              Create
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Import Modal */}
      <Modal
        opened={importModalOpened}
        onClose={closeImportModal}
        title="Import Workspace from JSON"
        size="lg"
        centered
      >
        <Stack gap="md">
          <Textarea
            label="Paste exported workspace JSON"
            placeholder='{"version": 1, ...}'
            value={importJson}
            onChange={(e) => setImportJson(e.currentTarget.value)}
            minRows={12}
            autosize
            maxRows={20}
            data-autofocus
          />
          <Group justify="flex-end" gap="sm">
            <Button variant="subtle" color="gray" onClick={closeImportModal}>
              Cancel
            </Button>
            <Button onClick={handleImport} loading={isImporting} disabled={!importJson.trim()}>
              Create
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
