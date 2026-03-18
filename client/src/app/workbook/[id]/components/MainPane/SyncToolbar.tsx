'use client';

import { ButtonPrimarySolid, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { DottedUnderlineButton } from '@/app/components/base/DottedUnderlineButton';
import { Text12Regular } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { ConfirmDialog, useConfirmDialog } from '@/app/components/modals/ConfirmDialog';
import { useDevTools } from '@/hooks/use-dev-tools';
import { getHumanReadableErrorMessage } from '@/lib/api/error';
import { syncApi } from '@/lib/api/sync';
import { useSyncStore } from '@/stores/sync-store';
import { timeAgo } from '@/utils/helpers';
import { RouteUrls } from '@/utils/route-urls';
import { ActionIcon, Box, Group, Menu, Modal, Paper, ScrollArea, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import type { SyncId, ValidateSyncMappingTypesResponse, WorkbookId } from '@spinner/shared-types';
import {
  BracesIcon,
  CheckIcon,
  CloudUploadIcon,
  EllipsisVertical,
  ListChecksIcon,
  PlayIcon,
  RefreshCwIcon,
  Trash2Icon,
  Wand2Icon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SyncScheduleModal, getScheduleLabel } from '../shared/SyncScheduleModal';

interface SyncToolbarProps {
  workbookId: WorkbookId;
  syncId: SyncId | 'new';
  syncName: string;
  syncNamePlaceholder: string;
  onSyncNameChange: (name: string) => void;
  schedule: string;
  onScheduleChange: (schedule: string) => void;
  onSave: () => Promise<void>;
  saving: boolean;
  hasUnsavedChanges: boolean;
  canSave: boolean;
  enableValidation: boolean;
  onEnableValidationChange: (enabled: boolean) => void;
  autoPublish: boolean;
  onAutoPublishChange: (enabled: boolean) => void;
  editorMode: 'visual' | 'json';
  onEditorModeChange: (mode: string) => void;
  onReapplyDefaults: (scope: 'current' | 'all') => void;
}

// Shared styles for the title input and static text to prevent layout shift
const TITLE_FONT_SIZE = '16px';
const TITLE_FONT_WEIGHT = 475;
const TITLE_LINE_HEIGHT = '20px';
const TITLE_MAX_WIDTH = 360;

export function SyncToolbar({
  workbookId,
  syncId,
  syncName,
  syncNamePlaceholder,
  onSyncNameChange,
  schedule,
  onScheduleChange,
  onSave,
  saving,
  hasUnsavedChanges,
  canSave,
  enableValidation,
  onEnableValidationChange,
  autoPublish,
  onAutoPublishChange,
  editorMode,
  onEditorModeChange,
  onReapplyDefaults,
}: SyncToolbarProps) {
  const router = useRouter();
  const syncs = useSyncStore((state) => state.syncs);
  const activeJobs = useSyncStore((state) => state.activeJobs);
  const fetchSyncs = useSyncStore((state) => state.fetchSyncs);
  const runSync = useSyncStore((state) => state.runSync);

  const isNew = syncId === 'new';
  const existingSync = useMemo(() => syncs.find((s) => s.id === syncId), [syncs, syncId]);
  const isRunning = !isNew && !!activeJobs[syncId];
  const { isDevToolsEnabled } = useDevTools();

  // Schedule modal
  const [scheduleModalOpened, { open: openScheduleModal, close: closeScheduleModal }] = useDisclosure(false);

  // Validate mapping types result modal (debug)
  const [validateResultModalOpened, { open: openValidateResultModal, close: closeValidateResultModal }] =
    useDisclosure(false);
  const [validateResult, setValidateResult] = useState<ValidateSyncMappingTypesResponse | { error: string } | null>(
    null,
  );

  // Inline title editing — new syncs start in edit mode
  const [isEditingTitle, setIsEditingTitle] = useState(isNew);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const startEditing = () => {
    setEditValue(syncName);
    setIsEditingTitle(true);
  };

  // When entering edit mode, focus and select all (for existing syncs)
  useEffect(() => {
    if (isEditingTitle && inputRef.current) {
      inputRef.current.focus();
      if (!isNew && syncName) {
        inputRef.current.select();
      }
    }
  }, [isEditingTitle, isNew, syncName]);

  const commitTitle = () => {
    const trimmed = editValue.trim();
    if (trimmed) {
      onSyncNameChange(trimmed);
    }
    // For existing syncs, exit edit mode. For new syncs, stay in edit mode (input stays).
    if (!isNew) {
      setIsEditingTitle(false);
    }
  };

  const cancelEditing = () => {
    // Revert and exit edit mode (only meaningful for existing syncs)
    setEditValue(syncName);
    if (!isNew) {
      setIsEditingTitle(false);
    }
  };

  // Confirm dialog
  const { open: openConfirmDialog, dialogProps } = useConfirmDialog();

  const handleRunSync = useCallback(async () => {
    if (isNew) return;

    // If there are unsaved changes, save first then run
    if (hasUnsavedChanges) {
      try {
        await onSave();
      } catch {
        // Save failed — error banner is already shown by onSave, don't run
        return;
      }
      try {
        await runSync(workbookId, syncId);
        notifications.show({
          title: 'Sync started',
          message: 'Changes saved and sync job has been queued',
          color: 'green',
        });
      } catch (error) {
        notifications.show({
          title: 'Failed to start sync',
          message: getHumanReadableErrorMessage(error),
          color: 'red',
        });
      }
      return;
    }

    try {
      await runSync(workbookId, syncId);
      notifications.show({
        title: 'Sync started',
        message: 'Sync job has been queued',
        color: 'green',
      });
    } catch (error) {
      notifications.show({
        title: 'Failed to start sync',
        message: getHumanReadableErrorMessage(error),
        color: 'red',
      });
    }
  }, [isNew, hasUnsavedChanges, onSave, runSync, workbookId, syncId]);

  const handleDelete = useCallback(() => {
    if (isNew) return;

    openConfirmDialog({
      title: 'Delete Sync',
      message: `Are you sure you want to delete "${syncName}"? This action cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
      onConfirm: async () => {
        try {
          await syncApi.delete(workbookId, syncId);
          await fetchSyncs(workbookId);
          notifications.show({
            title: 'Sync deleted',
            message: `"${syncName}" has been deleted`,
            color: 'green',
          });
          router.push(`/workbook/${workbookId}/syncs`);
        } catch (error) {
          console.debug('Failed to delete sync:', error);
          notifications.show({
            title: 'Failed to delete sync',
            message: getHumanReadableErrorMessage(error),
            color: 'red',
          });
        }
      },
    });
  }, [isNew, syncName, workbookId, syncId, openConfirmDialog, fetchSyncs, router]);

  const handleValidateMappingTypes = useCallback(async () => {
    if (isNew) return;
    setValidateResult(null);
    openValidateResultModal();
    try {
      const result = await syncApi.validateSyncMappingTypes(workbookId, syncId as SyncId);
      setValidateResult(result);
    } catch (error) {
      setValidateResult({
        error: getHumanReadableErrorMessage(error),
      });
    }
  }, [workbookId, syncId, isNew, openValidateResultModal]);

  const lastRunDisplay = existingSync?.lastSyncTime ? timeAgo(existingSync.lastSyncTime) : null;

  const displayPlaceholder = syncNamePlaceholder || 'Untitled sync';
  const displayTitle = syncName || '';

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
      {/* Left side: Title, Schedule, Last Run */}
      <Group gap="sm" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
        {/* Inline editable title */}
        {isEditingTitle ? (
          <Group gap={4} wrap="nowrap" align="center" style={{ maxWidth: TITLE_MAX_WIDTH, minWidth: 0 }}>
            <input
              ref={inputRef}
              value={isNew ? syncName : editValue}
              placeholder={displayPlaceholder}
              onChange={(e) => {
                if (isNew) {
                  onSyncNameChange(e.target.value);
                } else {
                  setEditValue(e.target.value);
                }
              }}
              onBlur={commitTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commitTitle();
                  (e.target as HTMLInputElement).blur();
                }
                if (e.key === 'Escape') cancelEditing();
              }}
              style={{
                fontSize: TITLE_FONT_SIZE,
                fontWeight: TITLE_FONT_WEIGHT,
                lineHeight: TITLE_LINE_HEIGHT,
                flex: 1,
                minWidth: 80,
                border: 'none',
                borderBottom: '1px solid var(--fg-divider)',
                background: 'transparent',
                outline: 'none',
                padding: '0 0 1px 0',
                margin: 0,
                fontFamily: 'inherit',
                color: 'var(--fg-primary)',
              }}
            />
          </Group>
        ) : (
          <Box
            onClick={startEditing}
            style={{
              fontSize: TITLE_FONT_SIZE,
              fontWeight: TITLE_FONT_WEIGHT,
              lineHeight: TITLE_LINE_HEIGHT,
              maxWidth: TITLE_MAX_WIDTH,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              cursor: 'text',
              color: 'var(--fg-primary)',
              borderBottom: '1px solid transparent',
              padding: '0 0 1px 0',
            }}
          >
            {displayTitle}
          </Box>
        )}

        <Box mx={4} style={{ flexShrink: 0 }}>
          <DottedUnderlineButton size="xs" onClick={openScheduleModal}>
            {getScheduleLabel(schedule, 'toolbar')}
          </DottedUnderlineButton>
        </Box>

        {!isNew && (
          <Link
            href={RouteUrls.workbookRunsPageUrl(workbookId, { syncId: syncId as string })}
            style={{ textDecoration: 'none' }}
          >
            <Text12Regular c="var(--fg-secondary)" style={{ whiteSpace: 'nowrap', textDecoration: 'underline' }}>
              Recent runs
            </Text12Regular>
          </Link>
        )}
        {!isNew && lastRunDisplay && (
          <Text12Regular c="var(--mantine-color-green-6)" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
            Last successful run {lastRunDisplay} {'\u2713'}
          </Text12Regular>
        )}
      </Group>

      {/* Right side: Actions */}
      <Group gap="xs">
        {!isNew && (
          <ButtonPrimarySolid
            size="compact-sm"
            leftSection={
              isRunning ? (
                <RefreshCwIcon size={12} style={{ animation: 'spin 1s linear infinite' }} />
              ) : (
                <StyledLucideIcon Icon={PlayIcon} size="sm" />
              )
            }
            onClick={handleRunSync}
            disabled={isRunning}
          >
            {isRunning ? 'Running...' : hasUnsavedChanges ? 'Save & Run' : 'Run Now'}
          </ButtonPrimarySolid>
        )}

        <ButtonSecondaryOutline size="compact-sm" onClick={onSave} loading={saving} disabled={!canSave}>
          {isNew ? 'Create' : 'Save'}
        </ButtonSecondaryOutline>

        <Tooltip label={editorMode === 'visual' ? 'Edit as JSON' : 'Edit visually'}>
          <ActionIcon
            variant={editorMode === 'json' ? 'light' : 'subtle'}
            color={editorMode === 'json' ? 'blue' : 'gray'}
            aria-label="Toggle JSON editor"
            onClick={() => onEditorModeChange(editorMode === 'visual' ? 'json' : 'visual')}
          >
            <StyledLucideIcon Icon={BracesIcon} size="sm" />
          </ActionIcon>
        </Tooltip>

        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon variant="subtle" color="gray" aria-label="More options">
              <StyledLucideIcon Icon={EllipsisVertical} size="sm" />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item
              leftSection={<ListChecksIcon size={16} />}
              rightSection={enableValidation ? <CheckIcon size={14} /> : null}
              onClick={() => onEnableValidationChange(!enableValidation)}
            >
              Validate mappings
            </Menu.Item>
            <Menu.Item
              leftSection={<CloudUploadIcon size={16} />}
              rightSection={autoPublish ? <CheckIcon size={14} /> : null}
              onClick={() => onAutoPublishChange(!autoPublish)}
            >
              Auto-publish after sync
            </Menu.Item>
            {!isNew && (
              <>
                <Menu.Divider />
                <Menu.Item data-delete leftSection={<Trash2Icon size={16} />} onClick={handleDelete}>
                  Delete sync
                </Menu.Item>
              </>
            )}
            {isDevToolsEnabled && (
              <>
                <Menu.Divider />
                <Menu.Label>Debug Options</Menu.Label>
                <Menu.Item
                  leftSection={<Wand2Icon size={16} />}
                  onClick={() => onReapplyDefaults('current')}
                  color="var(--mantine-color-devTool-9)"
                >
                  Reapply default transforms (Current Table)
                </Menu.Item>
                <Menu.Item
                  leftSection={<Wand2Icon size={16} />}
                  onClick={() => onReapplyDefaults('all')}
                  color="var(--mantine-color-devTool-9)"
                >
                  Reapply default transforms (All Tables)
                </Menu.Item>
                {!isNew && (
                  <Menu.Item
                    leftSection={<ListChecksIcon size={16} />}
                    onClick={handleValidateMappingTypes}
                    color="var(--mantine-color-devTool-9)"
                  >
                    Validate
                  </Menu.Item>
                )}
              </>
            )}
          </Menu.Dropdown>
        </Menu>
      </Group>

      {/* Modals */}
      <SyncScheduleModal
        opened={scheduleModalOpened}
        onClose={closeScheduleModal}
        currentSchedule={schedule}
        onSave={onScheduleChange}
      />
      <ConfirmDialog {...dialogProps} />

      <Modal
        opened={validateResultModalOpened}
        onClose={closeValidateResultModal}
        title="Validate mapping types"
        size="lg"
      >
        <ScrollArea.Autosize mah={400} type="scroll">
          <Paper withBorder p="sm" style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
            {validateResult != null ? JSON.stringify(validateResult, null, 2) : 'Loading…'}
          </Paper>
        </ScrollArea.Autosize>
      </Modal>

      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </Box>
  );
}
