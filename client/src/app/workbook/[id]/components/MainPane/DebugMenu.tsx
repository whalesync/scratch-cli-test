'use client';

import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { ConfirmDialog, useConfirmDialog } from '@/app/components/modals/ConfirmDialog';
import { DeleteConfirmDialog, useDeleteConfirmDialog } from '@/app/components/modals/DeleteConfirmDialog';
import { useDevTools } from '@/hooks/use-dev-tools';
import { usersApi } from '@/lib/api/users';
import { workbookApi } from '@/lib/api/workbook';
import { trackDeleteWorkbook } from '@/lib/posthog';
import { useWorkbookUIStore } from '@/stores/workbook-ui-store';
import { RouteUrls } from '@/utils/route-urls';
import { ActionIcon, Menu } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { WorkbookId } from '@spinner/shared-types';
import { ChevronRightIcon, DatabaseIcon, EllipsisVertical, LinkIcon, ServerCrashIcon, Trash2Icon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { mutate } from 'swr';
import { FileIndexModal } from '../modals/FileIndexModal';
import { RefIndexModal } from '../modals/RefIndexModal';

interface DebugMenuProps {
  workbookId: WorkbookId;
}

export function DebugMenu({ workbookId }: DebugMenuProps) {
  const { isDevToolsEnabled } = useDevTools();
  const [fileIndexOpen, setFileIndexOpen] = useState(false);
  const [refIndexOpen, setRefIndexOpen] = useState(false);
  const router = useRouter();
  const { open: openConfirmDialog, dialogProps } = useConfirmDialog();
  const { open: openDeleteConfirmDialog, dialogProps: deleteDialogProps } = useDeleteConfirmDialog();
  const setWorkbookError = useWorkbookUIStore((state) => state.setWorkbookError);

  const handleResetWorkbook = () => {
    openConfirmDialog({
      title: 'Reset Workspace',
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
            message: 'Failed to reset workspace',
            color: 'red',
          });
          console.error(e);
        }
      },
    });
  };

  const handleDeleteWorkbook = () => {
    openDeleteConfirmDialog({
      title: 'Delete Workspace',
      message: 'This will permanently delete this workspace and all its data. This action cannot be undone.',
      confirmPhrase: 'delete forever',
      confirmLabel: 'Delete Workspace',
      onConfirm: async () => {
        try {
          trackDeleteWorkbook(workbookId);
          await workbookApi.delete(workbookId);
          await usersApi.updateLastWorkbook(null);
          await mutate(() => true, undefined, { revalidate: false });
          router.push(RouteUrls.homePageUrl);
        } catch (e) {
          notifications.show({
            title: 'Error',
            message: 'Failed to delete workspace',
            color: 'red',
          });
          console.error(e);
        }
      },
    });
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
            Reset Workspace
          </Menu.Item>
          <Menu.Item data-delete leftSection={<Trash2Icon size={16} />} onClick={handleDeleteWorkbook}>
            Delete Workspace
          </Menu.Item>

          {isDevToolsEnabled && (
            <>
              <Menu.Divider />
              <Menu.Label>Debug Tools</Menu.Label>
              <Menu trigger="hover" position="left-start" offset={0} withinPortal>
                <Menu.Target>
                  <Menu.Item
                    data-devtool
                    leftSection={<DatabaseIcon size={16} />}
                    rightSection={<ChevronRightIcon size={14} />}
                  >
                    Index Tools
                  </Menu.Item>
                </Menu.Target>

                <Menu.Dropdown>
                  <Menu.Item
                    data-devtool
                    leftSection={<DatabaseIcon size={16} />}
                    onClick={() => setFileIndexOpen(true)}
                  >
                    File Index
                  </Menu.Item>
                  <Menu.Item data-devtool leftSection={<LinkIcon size={16} />} onClick={() => setRefIndexOpen(true)}>
                    Ref Index
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
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
                Test Workspace Error
              </Menu.Item>
            </>
          )}
        </Menu.Dropdown>
      </Menu>

      <FileIndexModal opened={fileIndexOpen} onClose={() => setFileIndexOpen(false)} workbookId={workbookId} />

      <RefIndexModal opened={refIndexOpen} onClose={() => setRefIndexOpen(false)} workbookId={workbookId} />

      {/* Confirm Dialogs */}
      <ConfirmDialog {...dialogProps} />
      <DeleteConfirmDialog {...deleteDialogProps} />
    </>
  );
}
