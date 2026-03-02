'use client';

import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Text13Medium, Text13Regular } from '@/app/components/base/text';
import { useWorkbooks } from '@/hooks/use-workbooks';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { workbookApi } from '@/lib/api/workbook';
import { usersApi } from '@/lib/api/users';
import { Box, Button, Group, Menu, Modal, Stack, TextInput, Tooltip, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import type { Workbook, WorkbookId } from '@spinner/shared-types';
import { ArrowUpCircleIcon, CheckIcon, ChevronDownIcon, FlaskRoundIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useRef, useState } from 'react';

// Project colors for differentiation
const PROJECT_COLORS = [
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

function getProjectColor(index: number): string {
  return PROJECT_COLORS[index % PROJECT_COLORS.length];
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
  currentWorkbook: Workbook;
}

export function ProjectSwitcher({ currentWorkbook }: ProjectSwitcherProps) {
  const router = useRouter();
  const { workbooks, createWorkbook, updateWorkbook } = useWorkbooks();
  const { user } = useScratchPadUser();
  const isAdmin = user?.isAdmin ?? false;
  const [menuOpened, setMenuOpened] = useState(false);

  // Rename modal state
  const [renameModalOpened, { open: openRenameModal, close: closeRenameModal }] = useDisclosure(false);
  const [workbookToRename, setWorkbookToRename] = useState<Workbook | null>(null);
  const [newName, setNewName] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);

  // Create modal state
  const [createModalOpened, { open: openCreateModal, close: closeCreateModal }] = useDisclosure(false);
  const [createName, setCreateName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const createVersionRef = useRef<number>(1);
  const [migratingToV2Id, setMigratingToV2Id] = useState<WorkbookId | null>(null);

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
    (e: React.MouseEvent, workbook: Workbook) => {
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
    createVersionRef.current = 1;
    setCreateName('');
    setMenuOpened(false);
    openCreateModal();
  }, [openCreateModal]);

  const handleOpenCreateV2 = useCallback(() => {
    createVersionRef.current = 2;
    setCreateName('');
    setMenuOpened(false);
    openCreateModal();
  }, [openCreateModal]);

  const handleMigrateToV2 = useCallback(
    async (e: React.MouseEvent, workbookId: WorkbookId) => {
      e.stopPropagation();
      setMigratingToV2Id(workbookId);
      setMenuOpened(false);
      try {
        await workbookApi.migrateToV2(workbookId);
      } catch (error) {
        console.error('Failed to migrate workbook to V2:', error);
      } finally {
        setMigratingToV2Id(null);
      }
    },
    [],
  );

  const handleCreate = useCallback(async () => {
    if (!createName.trim()) return;

    setIsCreating(true);
    try {
      const version = createVersionRef.current;
      const newWorkbook = await createWorkbook({
        name: createName.trim(),
        ...(version > 1 ? { version } : {}),
      });
      closeCreateModal();
      // Navigate to the new workbook
      router.push(`/workbook/${newWorkbook.id}/files`);
    } catch (error) {
      console.error('Failed to create workbook:', error);
    } finally {
      setIsCreating(false);
    }
  }, [createName, createWorkbook, closeCreateModal, router]);

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
                <ScratchLogo size={21} backgroundColor={getProjectColor(currentIndex)} />
                <Text13Medium truncate style={{ flex: 1 }}>
                  {currentWorkbook.name ?? 'Untitled'}
                </Text13Medium>
              </Group>
              <StyledLucideIcon Icon={ChevronDownIcon} size="sm" c="var(--fg-secondary)" />
            </Group>
          </UnstyledButton>
        </Menu.Target>

        <Menu.Dropdown>
          {/* Workbook list */}
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
                    <ScratchLogo size={21} backgroundColor={getProjectColor(index)} />
                    <Text13Regular truncate style={{ flex: 1 }}>
                      {workbook.name ?? 'Untitled'}
                    </Text13Regular>
                  </Group>
                  <Group gap={4} wrap="nowrap">
                    {isCurrent && <StyledLucideIcon Icon={CheckIcon} size="sm" c="var(--fg-primary)" />}
                    {isAdmin && (workbook.version ?? 1) < 2 && (
                      <Tooltip label="Migrate to V2" position="top">
                        <Box
                          onClick={(e: React.MouseEvent) => handleMigrateToV2(e, workbook.id as WorkbookId)}
                          style={{
                            cursor: migratingToV2Id === workbook.id ? 'default' : 'pointer',
                            padding: 2,
                            borderRadius: 4,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            opacity: migratingToV2Id === workbook.id ? 0.5 : 1,
                            color: 'var(--mantine-color-devTool-8)',
                          }}
                        >
                          <ArrowUpCircleIcon size={14} />
                        </Box>
                      </Tooltip>
                    )}
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

          {/* New Project */}
          <Menu.Item onClick={handleOpenCreate} leftSection={<PlusIcon size={14} />}>
            <Text13Regular c="var(--fg-secondary)">New Project</Text13Regular>
          </Menu.Item>

          {/* New Project V2 (admin only) */}
          {isAdmin && (
            <Menu.Item onClick={handleOpenCreateV2} leftSection={<FlaskRoundIcon size={14} />} data-devtool>
              <Text13Regular c="var(--mantine-color-devTool-8)">New Project (V2)</Text13Regular>
            </Menu.Item>
          )}
        </Menu.Dropdown>
      </Menu>

      {/* Rename Modal */}
      <Modal opened={renameModalOpened} onClose={closeRenameModal} title="Rename Project" size="sm" centered>
        <Stack gap="md">
          <TextInput
            label="Project Name"
            placeholder="My Project"
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
      <Modal
        opened={createModalOpened}
        onClose={closeCreateModal}
        title={createVersionRef.current > 1 ? 'New Project (V2)' : 'New Project'}
        size="sm"
        centered
      >
        <Stack gap="md">
          <TextInput
            label="Project Name"
            placeholder="My Project"
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
    </>
  );
}
