import { TextTitle2 } from '@/components/base/text';
import { ScratchJsonCodeMirror } from '@/components/ScratchJsonCodeMirror';
import { Box, Loader, Modal, Stack } from '@mantine/core';
import { useEffect, useState } from 'react';
import { buildColumnDefinitions } from '../../../../shared/schema-columns';

interface ColumnDefinitionsModalProps {
  folderPath: string;
  workspacePath: string;
  onClose: () => void;
}

export function ColumnDefinitionsModal({ folderPath, workspacePath, onClose }: ColumnDefinitionsModalProps) {
  const [json, setJson] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.scratchFiles
      .getFolderMetadata(folderPath, workspacePath)
      .then((meta) => {
        if (cancelled) return;
        const columns = buildColumnDefinitions(meta.schema);
        setJson(JSON.stringify(columns, null, 2));
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [folderPath, workspacePath]);

  const folderName = folderPath.split('/').pop() ?? folderPath;

  return (
    <Modal
      opened
      onClose={onClose}
      title={<TextTitle2>Column Definitions — {folderName}</TextTitle2>}
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
      {error ? (
        <Box p="md" c="red">
          {error}
        </Box>
      ) : json === null ? (
        <Stack align="center" justify="center" p="xl">
          <Loader size="sm" />
        </Stack>
      ) : (
        <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <ScratchJsonCodeMirror value={json} readOnly />
        </Box>
      )}
    </Modal>
  );
}
