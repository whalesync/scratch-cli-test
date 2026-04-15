import { Box, Group, Loader, Modal, ScrollArea, Stack, Textarea, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { FileText, FolderOpen } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ButtonPrimarySolid, ButtonSecondaryGhost, ButtonSecondaryOutline } from '../../components/base/buttons';
import { Text12Medium, Text12Regular, TextTitle2 } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { type JsonRecordDiagnostic, diagnoseJsonRecordText } from '../../utils/json-record-diagnostics';

export interface InvalidJsonFileListEntry {
  filename: string;
  error: string;
  workingFilePath: string;
  reviewedFilePath: string;
  publishedFilePath: string;
}

interface InvalidJsonFilesModalProps {
  opened: boolean;
  onClose: () => void;
  entries: InvalidJsonFileListEntry[];
  /** Called after a successful save so the folder grid can reload. */
  onFileSaved?: () => void;
}

type BranchKey = 'working' | 'reviewed' | 'published';

const BRANCH_META: Record<BranchKey, { shortLabel: string; getPath: (e: InvalidJsonFileListEntry) => string }> = {
  working: { shortLabel: 'Working', getPath: (e) => e.workingFilePath },
  reviewed: { shortLabel: 'Reviewed', getPath: (e) => e.reviewedFilePath },
  published: { shortLabel: 'Published', getPath: (e) => e.publishedFilePath },
};

/** Strips `working:` / `reviewed:` / `published:` prefixes from each `; `-separated segment. */
function formatErrorForDisplay(error: string): string {
  return error
    .split('; ')
    .map((segment) => segment.replace(/^(working|reviewed|published):\s*/i, '').trim())
    .filter(Boolean)
    .join('; ');
}

/** Matches `compareRecordSnapshots` error segments (`working: …`, `reviewed: …`, `published: …`). */
function branchKeysWithErrors(error: string): BranchKey[] {
  const keys: BranchKey[] = [];
  if (error.includes('working:')) keys.push('working');
  if (error.includes('reviewed:')) keys.push('reviewed');
  if (error.includes('published:')) keys.push('published');
  return keys.length > 0 ? keys : ['working'];
}

const isMac = window.electron?.process?.platform === 'darwin';

function DiagnosticBanner({ diagnostic }: { diagnostic: JsonRecordDiagnostic }) {
  if (diagnostic.status === 'ok') {
    return (
      <Text12Regular c="var(--mantine-color-green-7)">
        Record is valid JSON. You can save or keep editing.
      </Text12Regular>
    );
  }
  if (diagnostic.status === 'empty') {
    return <Text12Regular c="var(--mantine-color-red-7)">{diagnostic.message}</Text12Regular>;
  }
  return (
    <Stack gap={4}>
      <Text12Regular c="var(--mantine-color-red-7)" style={{ whiteSpace: 'pre-wrap' }}>
        {diagnostic.message}
      </Text12Regular>
    </Stack>
  );
}

export const InvalidJsonFilesModal = memo(function InvalidJsonFilesModal({
  opened,
  onClose,
  entries,
  onFileSaved,
}: InvalidJsonFilesModalProps) {
  const [editModal, setEditModal] = useState<{ title: string; filePath: string } | null>(null);
  const [editLoading, setEditLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editorText, setEditorText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [saving, setSaving] = useState(false);

  const diagnostic = useMemo(() => diagnoseJsonRecordText(editorText), [editorText]);

  const dirty = editorText !== savedText;
  const canSave = editModal !== null && !loadError && dirty && !saving;

  const handleReveal = useCallback((filePath: string) => {
    void window.scratchDesktop.showItemInFolder(filePath);
  }, []);

  const handleOpenEdit = useCallback((filePath: string, filename: string) => {
    setEditModal({ title: filename, filePath });
    setEditorText('');
    setSavedText('');
    setLoadError(null);
    setEditLoading(true);
    void window.scratchFiles.readFileTextRaw(filePath).then((result) => {
      setEditLoading(false);
      if ('error' in result && result.error) {
        setLoadError(result.error);
        return;
      }
      if ('text' in result) {
        setEditorText(result.text);
        setSavedText(result.text);
      }
    });
  }, []);

  const closeEditModal = useCallback(() => {
    setEditModal(null);
    setEditorText('');
    setSavedText('');
    setLoadError(null);
    setEditLoading(false);
    setSaving(false);
  }, []);

  const handleSave = useCallback(async () => {
    if (!editModal?.filePath || loadError || saving) return;
    if (editorText === savedText) return;
    setSaving(true);
    try {
      const result = await window.scratchFiles.writeFileTextRaw(editModal.filePath, editorText);
      setSaving(false);
      if ('error' in result) {
        notifications.show({ color: 'red', title: 'Save failed', message: result.error });
        return;
      }
      setSavedText(editorText);
      notifications.show({ color: 'green', title: 'Saved', message: 'File written to disk.' });
      onFileSaved?.();
      closeEditModal();
    } catch (err) {
      setSaving(false);
      notifications.show({
        color: 'red',
        title: 'Save failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [editModal?.filePath, loadError, saving, editorText, savedText, onFileSaved, closeEditModal]);

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
                        {branchKeysWithErrors(entry.error).map((key) => {
                          const branch = BRANCH_META[key];
                          const path = branch.getPath(entry);
                          return (
                            <Group key={key} gap={8} align="center" wrap="wrap">
                              <UnstyledButton
                                type="button"
                                onClick={() => handleReveal(path)}
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
                                onClick={() => handleOpenEdit(path, entry.filename)}
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
                          );
                        })}
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

      <Modal
        opened={editModal !== null}
        onClose={closeEditModal}
        title={<TextTitle2>{editModal?.title}</TextTitle2>}
        size="xl"
        padding="md"
        styles={{
          body: {
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            maxHeight: 'min(640px, 85vh)',
            paddingTop: 0,
            overflow: 'hidden',
          },
        }}
      >
        {editLoading ? (
          <Stack gap="sm">
            <Group justify="center" p="xl">
              <Loader size="sm" />
            </Group>
            <Group justify="flex-end" wrap="nowrap" gap="sm">
              <ButtonSecondaryGhost size="compact-sm" onClick={closeEditModal}>
                Cancel
              </ButtonSecondaryGhost>
            </Group>
          </Stack>
        ) : loadError ? (
          <Stack gap="sm">
            <Text12Regular c="var(--mantine-color-red-7)">{loadError}</Text12Regular>
            <Group justify="flex-end" wrap="nowrap" gap="sm">
              <ButtonSecondaryGhost size="compact-sm" onClick={closeEditModal}>
                Cancel
              </ButtonSecondaryGhost>
            </Group>
          </Stack>
        ) : (
          <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
            <DiagnosticBanner diagnostic={diagnostic} />

            <Textarea
              value={editorText}
              onChange={(e) => setEditorText(e.currentTarget.value)}
              label="Edit file"
              autosize
              minRows={12}
              maxRows={26}
              styles={{
                input: {
                  fontFamily:
                    'var(--mantine-font-family-monospace, ui-monospace, SFMono-Regular, Menlo, Monaco, monospace)',
                  fontSize: 12,
                  lineHeight: 1.5,
                },
                root: { flex: 1 },
              }}
            />

            <Group justify="flex-end" wrap="nowrap" gap="sm">
              <ButtonSecondaryGhost size="compact-sm" onClick={closeEditModal}>
                Cancel
              </ButtonSecondaryGhost>
              <ButtonPrimarySolid
                size="compact-sm"
                loading={saving}
                disabled={!canSave}
                onClick={() => void handleSave()}
              >
                Save to disk
              </ButtonPrimarySolid>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
});
