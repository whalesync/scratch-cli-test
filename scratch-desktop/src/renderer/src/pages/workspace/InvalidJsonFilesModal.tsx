import { Box, Group, Modal, ScrollArea, Stack, UnstyledButton } from '@mantine/core';
import { FileText, FolderOpen } from 'lucide-react';
import { memo, useCallback, useEffect, useState } from 'react';
import { RecordRawJsonFileEditorModal } from '../../components/RecordRawJsonFileEditorModal';
import { ButtonSecondaryOutline } from '../../components/base/buttons';
import { Text12Medium, Text12Regular, TextTitle2 } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';

export interface InvalidJsonFileListEntry {
  filename: string;
  error: string;
  /**
   * Path to the file in the user worktree on disk. Slice F retired the
   * sparse `dirty`/`master` mirrors, so the "approved" and "published"
   * versions only exist as git blobs — not openable as files.
   */
  workingFilePath: string;
}

interface InvalidJsonFilesModalProps {
  opened: boolean;
  onClose: () => void;
  entries: InvalidJsonFileListEntry[];
  /** Called after a successful save so the folder grid can reload. */
  onFileSaved?: () => void;
}

/** Strips `working:` / `reviewed:` / `published:` prefixes from each `; `-separated segment. */
function formatErrorForDisplay(error: string): string {
  return error
    .split('; ')
    .map((segment) => segment.replace(/^(working|reviewed|published):\s*/i, '').trim())
    .filter(Boolean)
    .join('; ');
}

const isMac = window.scratchDesktop.platform === 'darwin';

export const InvalidJsonFilesModal = memo(function InvalidJsonFilesModal({
  opened,
  onClose,
  entries,
  onFileSaved,
}: InvalidJsonFilesModalProps) {
  const [editModal, setEditModal] = useState<{ title: string; filePath: string } | null>(null);

  const handleReveal = useCallback((filePath: string) => {
    void window.scratchDesktop.showItemInFolder(filePath);
  }, []);

  const handleOpenEdit = useCallback((filePath: string, filename: string) => {
    setEditModal({ title: filename, filePath });
  }, []);

  const closeEditModal = useCallback(() => {
    setEditModal(null);
  }, []);

  useEffect(() => {
    if (!opened) {
      closeEditModal();
    }
  }, [opened, closeEditModal]);

  return (
    <>
      <Modal opened={opened} onClose={onClose} title={<TextTitle2>Invalid files</TextTitle2>} size="lg" padding="md">
        <Stack gap="md">
          {entries.length === 0 ? (
            <Text12Regular c="var(--mantine-color-green-7)">All files in this folder are valid JSON</Text12Regular>
          ) : (
            <>
              <Text12Regular c="var(--fg-muted)" style={{ marginBottom: 0 }}>
                These record files are not valid top-level JSON objects on disk. Reveal the file in{' '}
                {isMac ? 'Finder' : 'File Explorer'} or inspect and edit the raw contents below.
              </Text12Regular>
              <ScrollArea style={{ maxHeight: 'min(420px, 60vh)' }} type="auto">
                <Stack gap="md">
                  {entries.map((entry) => (
                    <Box
                      key={entry.filename}
                      style={{
                        padding: 10,
                        borderRadius: 6,
                        border: '0.5px solid var(--fg-divider)',
                        backgroundColor: 'var(--bg-panel)',
                      }}
                    >
                      <Text12Medium style={{ wordBreak: 'break-all' }}>{entry.filename}</Text12Medium>
                      <Text12Regular c="var(--mantine-color-red-6)" style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
                        {formatErrorForDisplay(entry.error)}
                      </Text12Regular>
                      <Stack gap={6} style={{ marginTop: 10 }}>
                        <Group gap={8} align="center" wrap="wrap">
                          <UnstyledButton
                            type="button"
                            onClick={() => handleReveal(entry.workingFilePath)}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              padding: '2px 6px',
                              borderRadius: 4,
                              border: '0.5px solid var(--fg-divider)',
                              cursor: 'pointer',
                            }}
                          >
                            <StyledLucideIcon Icon={FolderOpen} size={12} c="var(--fg-muted)" />
                            <Text12Regular c="var(--fg-primary)">
                              {isMac ? 'Show in Finder' : 'Show in Explorer'}
                            </Text12Regular>
                          </UnstyledButton>
                          <UnstyledButton
                            type="button"
                            onClick={() => handleOpenEdit(entry.workingFilePath, entry.filename)}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 4,
                              padding: '2px 6px',
                              borderRadius: 4,
                              border: '0.5px solid var(--fg-divider)',
                              cursor: 'pointer',
                            }}
                          >
                            <StyledLucideIcon Icon={FileText} size={12} c="var(--fg-muted)" />
                            <Text12Regular c="var(--fg-primary)">View file</Text12Regular>
                          </UnstyledButton>
                        </Group>
                      </Stack>
                    </Box>
                  ))}
                </Stack>
              </ScrollArea>
            </>
          )}
          <Group justify="flex-end" wrap="nowrap" gap="sm">
            <ButtonSecondaryOutline size="compact-sm" onClick={onClose}>
              Close
            </ButtonSecondaryOutline>
          </Group>
        </Stack>
      </Modal>

      <RecordRawJsonFileEditorModal
        opened={editModal !== null}
        onClose={closeEditModal}
        filePath={editModal?.filePath ?? ''}
        title={editModal?.title ?? ''}
        onFileSaved={onFileSaved}
      />
    </>
  );
});
