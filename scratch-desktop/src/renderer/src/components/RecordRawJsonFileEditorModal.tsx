import { Box, Group, Loader, Modal, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { type JsonRecordDiagnostic, diagnoseJsonRecordText } from '../utils/json-record-diagnostics';
import { ScratchJsonCodeMirror } from './ScratchJsonCodeMirror';
import { ButtonPrimarySolid, ButtonSecondaryGhost } from './base/buttons';
import { Text12Medium, Text12Regular, TextTitle2 } from './base/text';

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

export interface RecordRawJsonFileEditorModalProps {
  opened: boolean;
  onClose: () => void;
  /** Absolute path on disk; load is skipped when empty. */
  filePath: string;
  /** Modal title (usually the filename). */
  title: string;
  onFileSaved?: () => void;
}

export const RecordRawJsonFileEditorModal = memo(function RecordRawJsonFileEditorModal({
  opened,
  onClose,
  filePath,
  title,
  onFileSaved,
}: RecordRawJsonFileEditorModalProps) {
  const [editLoading, setEditLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editorText, setEditorText] = useState('');
  const [savedText, setSavedText] = useState('');
  const [saving, setSaving] = useState(false);

  const diagnostic = useMemo(() => diagnoseJsonRecordText(editorText), [editorText]);

  const dirty = editorText !== savedText;
  const canSave = opened && filePath.length > 0 && !loadError && dirty && !saving;

  const resetEditorState = useCallback(() => {
    setEditorText('');
    setSavedText('');
    setLoadError(null);
    setEditLoading(false);
    setSaving(false);
  }, []);

  useEffect(() => {
    if (!opened || !filePath) {
      resetEditorState();
      return;
    }

    setLoadError(null);
    setEditLoading(true);
    setEditorText('');
    setSavedText('');
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
  }, [opened, filePath, resetEditorState]);

  const handleSave = useCallback(async () => {
    if (!filePath || loadError || saving) return;
    if (editorText === savedText) return;
    setSaving(true);
    try {
      const result = await window.scratchFiles.writeFileTextRaw(filePath, editorText);
      setSaving(false);
      if ('error' in result) {
        notifications.show({ color: 'red', title: 'Save failed', message: result.error });
        return;
      }
      setSavedText(editorText);
      notifications.show({ color: 'green', title: 'Saved', message: 'File written to disk.' });
      onFileSaved?.();
      onClose();
    } catch (err) {
      setSaving(false);
      notifications.show({
        color: 'red',
        title: 'Save failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [filePath, loadError, saving, editorText, savedText, onFileSaved, onClose]);

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
      {editLoading ? (
        <Stack gap="sm">
          <Group justify="center" p="xl">
            <Loader size="sm" />
          </Group>
          <Group justify="flex-end" wrap="nowrap" gap="sm">
            <ButtonSecondaryGhost size="compact-sm" onClick={onClose}>
              Cancel
            </ButtonSecondaryGhost>
          </Group>
        </Stack>
      ) : loadError ? (
        <Stack gap="sm">
          <Text12Regular c="var(--mantine-color-red-7)">{loadError}</Text12Regular>
          <Group justify="flex-end" wrap="nowrap" gap="sm">
            <ButtonSecondaryGhost size="compact-sm" onClick={onClose}>
              Cancel
            </ButtonSecondaryGhost>
          </Group>
        </Stack>
      ) : (
        <Stack gap="sm" style={{ flex: 1, minHeight: 0 }}>
          <DiagnosticBanner diagnostic={diagnostic} />

          <Box style={{ flex: 1, minHeight: 240, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <Text12Medium style={{ marginBottom: 6 }}>Edit file</Text12Medium>
            <Box
              style={{
                flex: 1,
                minHeight: 0,
                overflow: 'auto',
                borderRadius: 6,
                border: '0.5px solid var(--fg-divider)',
              }}
            >
              <ScratchJsonCodeMirror value={editorText} onChange={setEditorText} />
            </Box>
          </Box>

          <Group justify="flex-end" wrap="nowrap" gap="sm">
            <ButtonSecondaryGhost size="compact-sm" onClick={onClose}>
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
  );
});
