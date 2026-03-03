'use client';

import { ButtonPrimarySolid, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text12Regular } from '@/app/components/base/text';
import { ConfirmDialog, useConfirmDialog } from '@/app/components/modals/ConfirmDialog';
import { useActiveWorkbook } from '@/hooks/use-active-workbook';
import { SWR_KEYS } from '@/lib/api/keys';
import { workbookApi } from '@/lib/api/workbook';
import { useReviewToolbarStore } from '@/stores/review-toolbar-store';
import { useWorkbookUIStore, WorkbookModals } from '@/stores/workbook-ui-store';
import { RouteUrls } from '@/utils/route-urls';
import { Box, Group, Menu, SegmentedControl } from '@mantine/core';
import type { WorkbookId } from '@spinner/shared-types';
import { ChevronDownIcon, CloudUploadIcon, RotateCcwIcon, SaveIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { PublishPlansModal } from '../modals/PublishPlansModal';

interface ReviewSubToolbarProps {
  workbookId: string;
}

export function ReviewSubToolbar({ workbookId }: ReviewSubToolbarProps) {
  const router = useRouter();
  const { discardAllChanges } = useActiveWorkbook();
  const activeModal = useWorkbookUIStore((state) => state.activeModal);
  const showModal = useWorkbookUIStore((state) => state.showModal);
  const dismissModal = useWorkbookUIStore((state) => state.dismissModal);

  const viewMode = useReviewToolbarStore((state) => state.viewMode);
  const setViewMode = useReviewToolbarStore((state) => state.setViewMode);
  const summary = useReviewToolbarStore((state) => state.summary);
  const fileActions = useReviewToolbarStore((state) => state.fileActions);

  const [isDiscardingAll, setIsDiscardingAll] = useState(false);

  const { data: dirtyStatus, mutate: mutateDirtyStatus } = useSWR(
    SWR_KEYS.dirtyFiles.hasDirty(workbookId as WorkbookId),
    () => workbookApi.hasDirtyFiles(workbookId as WorkbookId),
  );
  const { mutate } = useSWRConfig();
  const hasDirty = dirtyStatus?.dirty ?? false;

  const publishV2ModalOpened = activeModal?.type === WorkbookModals.PUBLISH_PLANS;
  const openPublishV2Modal = () => showModal({ type: WorkbookModals.PUBLISH_PLANS });
  const closePublishV2Modal = () => dismissModal(WorkbookModals.PUBLISH_PLANS);

  const { open: openConfirmDialog, dialogProps } = useConfirmDialog();

  const handleDiscardAll = useCallback(() => {
    openConfirmDialog({
      title: 'Discard All Changes',
      message: 'Are you sure you want to discard all unpublished changes? This cannot be undone.',
      confirmLabel: 'Discard',
      variant: 'danger',
      onConfirm: async () => {
        setIsDiscardingAll(true);
        try {
          await discardAllChanges();
          mutateDirtyStatus();
          mutate(SWR_KEYS.dirtyFiles.list(workbookId as WorkbookId));
          router.push(RouteUrls.workbookReviewPageUrl(workbookId));
        } finally {
          setIsDiscardingAll(false);
        }
      },
    });
  }, [router, openConfirmDialog, discardAllChanges, workbookId, mutateDirtyStatus, mutate]);

  const hasFileActions = fileActions.onPublishFile !== null;

  if (!hasDirty) return null;

  return (
    <Box
      px="sm"
      py={6}
      style={{
        borderBottom: '1px solid var(--fg-divider)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}
    >
      {/* Left: View mode toggle (file view) or summary text (folder view) */}
      <Group gap="xs">
        {hasFileActions ? (
          <SegmentedControl
            size="xs"
            value={viewMode}
            onChange={(value) => setViewMode(value as 'split' | 'unified')}
            data={[
              { value: 'split', label: 'Side-by-side' },
              { value: 'unified', label: 'Inline' },
            ]}
          />
        ) : (
          summary && <Text12Regular c="var(--fg-muted)">{summary}</Text12Regular>
        )}
      </Group>

      {/* Right: Actions */}
      <Group gap="xs">
        {/* Publish dropdown */}
        {hasFileActions ? (
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ButtonPrimarySolid
                size="compact-sm"
                leftSection={<CloudUploadIcon size={12} />}
                rightSection={<ChevronDownIcon size={12} />}
                loading={fileActions.isPublishing}
              >
                Publish
              </ButtonPrimarySolid>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<CloudUploadIcon size={16} />}
                onClick={fileActions.onPublishFile ?? undefined}
                disabled={fileActions.isPublishing}
              >
                Publish this file
              </Menu.Item>
              <Menu.Item leftSection={<CloudUploadIcon size={16} />} onClick={openPublishV2Modal}>
                Publish all
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        ) : (
          <ButtonPrimarySolid
            size="compact-sm"
            leftSection={<CloudUploadIcon size={12} />}
            onClick={openPublishV2Modal}
          >
            Publish all
          </ButtonPrimarySolid>
        )}

        {/* Discard dropdown */}
        {hasFileActions ? (
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <ButtonSecondaryOutline
                size="compact-sm"
                leftSection={<RotateCcwIcon size={12} />}
                rightSection={<ChevronDownIcon size={12} />}
                loading={fileActions.isDiscarding || isDiscardingAll}
                c="var(--mantine-color-red-6)"
                styles={{ inner: { color: 'var(--mantine-color-red-6)' } }}
              >
                Discard
              </ButtonSecondaryOutline>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item
                leftSection={<RotateCcwIcon size={16} />}
                onClick={fileActions.onDiscardFile ?? undefined}
                disabled={fileActions.isDiscarding}
              >
                Discard this file
              </Menu.Item>
              <Menu.Item leftSection={<RotateCcwIcon size={16} />} onClick={handleDiscardAll}>
                Discard all
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        ) : (
          <ButtonSecondaryOutline
            size="compact-sm"
            leftSection={<RotateCcwIcon size={12} />}
            onClick={handleDiscardAll}
            loading={isDiscardingAll}
            c="var(--mantine-color-red-6)"
            styles={{ inner: { color: 'var(--mantine-color-red-6)' } }}
          >
            Discard all
          </ButtonSecondaryOutline>
        )}

        {/* Save button (only when file has unsaved edits) */}
        {hasFileActions && fileActions.hasChanges && (
          <ButtonSecondaryOutline
            size="compact-sm"
            leftSection={<SaveIcon size={12} />}
            onClick={fileActions.onSaveFile ?? undefined}
            loading={fileActions.isSaving}
          >
            Save
          </ButtonSecondaryOutline>
        )}
      </Group>

      <PublishPlansModal
        opened={publishV2ModalOpened}
        onClose={closePublishV2Modal}
        workbookId={workbookId as WorkbookId}
      />

      <ConfirmDialog {...dialogProps} />
    </Box>
  );
}
