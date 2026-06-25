import { scratchApiClient } from '@/lib/scratch-api-client';
import { Group, Loader, Modal, Stack, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { WorkbookId } from '@spinner/shared-types';
import { memo, useCallback, useEffect, useState } from 'react';
import { ButtonPrimarySolid, ButtonSecondaryGhost } from './base/buttons';
import { Text12Regular, TextTitle2 } from './base/text';

export interface TextFileEditorModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
  /** Full repo path of the file (e.g. "/Drafts/post.md"); load is skipped when empty. */
  filePath: string;
  /** Modal title (usually the filename). */
  title: string;
  onFileSaved?: () => void;
}

/**
 * Plain-text editor for standalone "scratch" files (DEV-10424). Unlike the JSON record editor it
 * loads and saves through the server REST API (the scratch repo is connector-less and committed to
 * `main`) and applies no JSON validation — the file is raw bytes.
 */
export const TextFileEditorModal = memo(function TextFileEditorModal({
  opened,
  onClose,
  workbookId,
  filePath,
  title,
  onFileSaved,
}: TextFileEditorModalProps) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editorText, setEditorText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [saving, setSaving] = useState(false);

  const dirty = editorText !== savedText;
  const canSave = opened && filePath.length > 0 && !loadError && dirty && !saving;

  useEffect(() => {
    if (!opened || !filePath) {
      setEditorText('');
      setSavedText('');
      setLoadError(null);
      setLoading(false);
      setSaving(false);
      return;
    }
    let cancelled = false;
    setLoadError(null);
    setLoading(true);
    void scratchApiClient.files
      .getFileByPath(workbookId, filePath)
      .then((res) => {
        if (cancelled) return;
        const content = res.file.content ?? '';
        setEditorText(content);
        setSavedText(content);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [opened, filePath, workbookId]);

  const handleSave = useCallback(async () => {
    if (!filePath || loadError || saving || editorText === savedText) return;
    setSaving(true);
    try {
      await scratchApiClient.files.updateFileByPath(workbookId, filePath, { content: editorText });
      setSavedText(editorText);
      notifications.show({ color: 'green', title: 'Saved', message: 'File saved.' });
      onFileSaved?.();
      onClose();
    } catch (err) {
      notifications.show({
        color: 'red',
        title: 'Save failed',
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  }, [filePath, loadError, saving, editorText, savedText, workbookId, onFileSaved, onClose]);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={<TextTitle2>{title}</TextTitle2>}
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
      {loading ? (
        <Group justify="center" p="xl">
          <Loader size="sm" />
        </Group>
      ) : loadError ? (
        <Stack gap="sm">
          <Text12Regular c="var(--mantine-color-red-7)">{loadError}</Text12Regular>
          <Group justify="flex-end" gap="sm">
            <ButtonSecondaryGhost size="compact-sm" onClick={onClose}>
              Cancel
            </ButtonSecondaryGhost>
          </Group>
        </Stack>
      ) : (
        <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
          <Textarea
            value={editorText}
            onChange={(e) => setEditorText(e.currentTarget.value)}
            autosize
            minRows={12}
            maxRows={24}
            styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 13 } }}
          />
          <Group justify="flex-end" gap="sm">
            <ButtonSecondaryGhost size="compact-sm" onClick={onClose}>
              Cancel
            </ButtonSecondaryGhost>
            <ButtonPrimarySolid
              size="compact-sm"
              loading={saving}
              disabled={!canSave}
              onClick={() => void handleSave()}
            >
              Save
            </ButtonPrimarySolid>
          </Group>
        </Stack>
      )}
    </Modal>
  );
});
