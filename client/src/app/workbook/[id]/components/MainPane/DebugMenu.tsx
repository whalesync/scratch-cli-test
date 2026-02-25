'use client';

import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { ConfirmDialog, useConfirmDialog } from '@/app/components/modals/ConfirmDialog';
import { useDevTools } from '@/hooks/use-dev-tools';
import { workbookApi } from '@/lib/api/workbook';
import { useWorkbookEditorUIStore } from '@/stores/workbook-editor-store';
import { ActionIcon, Menu } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { WorkbookId } from '@spinner/shared-types';
import {
  DatabaseIcon,
  EllipsisVertical,
  FileCodeIcon,
  GitGraphIcon,
  GitMergeIcon,
  LinkIcon,
  ServerCrashIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { FileIndexModal } from '../modals/FileIndexModal';
import { GitFileBrowserModal } from '../modals/GitFileBrowserModal';
import { GitGraphModal } from '../modals/GitGraphModal';
import { RefIndexModal } from '../modals/RefIndexModal';

interface DebugMenuProps {
  workbookId: WorkbookId;
}

export function DebugMenu({ workbookId }: DebugMenuProps) {
  const { isDevToolsEnabled } = useDevTools();
  const [gitGraphOpen, setGitGraphOpen] = useState(false);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [fileIndexOpen, setFileIndexOpen] = useState(false);
  const [refIndexOpen, setRefIndexOpen] = useState(false);
  const { open: openConfirmDialog, dialogProps } = useConfirmDialog();
  const setWorkbookError = useWorkbookEditorUIStore((state) => state.setWorkbookError);
  const [isRebasing, setIsRebasing] = useState(false);

  const handleResetWorkbook = () => {
    openConfirmDialog({
      title: 'Reset Workbook',
      message: 'This will remove all data folders. Any unpublished changes will be lost. This action cannot be undone.',
      confirmLabel: 'Reset',
      variant: 'danger',
      onConfirm: async () => {
        try {
          await workbookApi.resetWorkbook(workbookId);
          window.location.reload();
        } catch (e) {
          notifications.show({
            title: 'Error',
            message: 'Failed to reset workbook',
            color: 'red',
          });
          console.error(e);
        }
      },
    });
  };

  const handleManualRebase = async () => {
    setIsRebasing(true);
    try {
      await workbookApi.rebaseDirty(workbookId);
      notifications.show({
        title: 'Success',
        message: 'Rebase complete',
        color: 'green',
      });
      window.location.reload();
    } catch (e) {
      notifications.show({
        title: 'Error',
        message: 'Failed to rebase',
        color: 'red',
      });
      console.error(e);
    } finally {
      setIsRebasing(false);
    }
  };

  return (
    <>
      <Menu shadow="md" width={200} position="bottom-end">
        <Menu.Target>
          <ActionIcon variant="subtle" color="gray">
            <StyledLucideIcon Icon={EllipsisVertical} size="sm" />
          </ActionIcon>
        </Menu.Target>

        <Menu.Dropdown>
          <Menu.Item data-delete leftSection={<Trash2Icon size={16} />} onClick={handleResetWorkbook}>
            Reset Workbook
          </Menu.Item>

          {isDevToolsEnabled && (
            <>
              <Menu.Divider />
              <Menu.Label>Debug Tools</Menu.Label>
              <Menu.Item data-devtool leftSection={<GitGraphIcon size={16} />} onClick={() => setGitGraphOpen(true)}>
                Git Graph
              </Menu.Item>
              <Menu.Item data-devtool leftSection={<FileCodeIcon size={16} />} onClick={() => setFileBrowserOpen(true)}>
                Git File Browser
              </Menu.Item>
              <Menu.Item
                data-devtool
                leftSection={<GitMergeIcon size={16} />}
                onClick={handleManualRebase}
                disabled={isRebasing}
              >
                Manual Rebase
              </Menu.Item>
              <Menu.Item data-devtool leftSection={<DatabaseIcon size={16} />} onClick={() => setFileIndexOpen(true)}>
                File Index
              </Menu.Item>
              <Menu.Item data-devtool leftSection={<LinkIcon size={16} />} onClick={() => setRefIndexOpen(true)}>
                Ref Index
              </Menu.Item>
              <Menu.Item
                data-devtool
                leftSection={<ServerCrashIcon size={16} />}
                onClick={() =>
                  setWorkbookError({
                    description: 'This is a test error',
                    cause: new Error('Test error'),
                  })
                }
              >
                Test Workbook Error
              </Menu.Item>
            </>
          )}
        </Menu.Dropdown>
      </Menu>

      <GitGraphModal opened={gitGraphOpen} onClose={() => setGitGraphOpen(false)} workbookId={workbookId} />

      <GitFileBrowserModal opened={fileBrowserOpen} onClose={() => setFileBrowserOpen(false)} workbookId={workbookId} />

      <FileIndexModal opened={fileIndexOpen} onClose={() => setFileIndexOpen(false)} workbookId={workbookId} />

      <RefIndexModal opened={refIndexOpen} onClose={() => setRefIndexOpen(false)} workbookId={workbookId} />

      {/* Confirm Dialog */}
      <ConfirmDialog {...dialogProps} />
    </>
  );
}
