import { Box, Group, Loader, ScrollArea, Stack } from '@mantine/core';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ButtonSecondaryOutline, IconButtonGhost } from '../../components/base/buttons';
import { Text12Medium, Text12Regular, TextMono12Regular, TextTitle2 } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { RecordFieldsGrid } from './RecordFieldsGrid';

interface RecordDetailViewProps {
  rows: Array<Record<string, unknown>>;
  selectedIndex: number;
  folderPath: string;
  workspacePath: string;
  titleColumnId: string | null;
  onSelectIndex: (index: number) => void;
  onClose: () => void;
}

function getRecordName(row: Record<string, unknown>, titleColumnId: string | null): string {
  if (titleColumnId) {
    const val = row[titleColumnId];
    if (typeof val === 'string' && val !== '') return val;
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  }
  // Fallback to filename
  const filename = row.__filename;
  if (typeof filename === 'string') return filename.replace(/\.json$/, '');
  return '';
}

export const RecordDetailView = memo(function RecordDetailView({
  rows,
  selectedIndex,
  folderPath,
  workspacePath,
  titleColumnId,
  onSelectIndex,
  onClose,
}: RecordDetailViewProps) {
  const [viewRaw, setViewRaw] = useState(false);
  const [rawData, setRawData] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const selectedItemRef = useRef<HTMLButtonElement | null>(null);

  const currentRow = rows[selectedIndex];
  const recordName = currentRow ? getRecordName(currentRow, titleColumnId) : '';

  // Load raw file data when selection changes
  useEffect(() => {
    const row = rows[selectedIndex];
    const filename = row?.__filename as string | undefined;
    if (!filename) return;

    let cancelled = false;
    setLoading(true);

    window.scratchFiles
      .readFile(`${folderPath}/${filename}`)
      .then((result) => {
        if (!cancelled && result.type === 'json') {
          setRawData(result.data);
        }
      })
      .catch(() => {
        if (!cancelled) setRawData(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedIndex, rows, folderPath]);

  // Escape key closes overlay (capture phase so it fires before the grid handles it)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  // Scroll selected item into view
  useEffect(() => {
    selectedItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  const handlePrev = useCallback(() => {
    if (selectedIndex > 0) onSelectIndex(selectedIndex - 1);
  }, [selectedIndex, onSelectIndex]);

  const handleNext = useCallback(() => {
    if (selectedIndex < rows.length - 1) onSelectIndex(selectedIndex + 1);
  }, [selectedIndex, rows.length, onSelectIndex]);

  const handleAcceptAll = useCallback(() => {
    void window.scratchDesktop.acceptAllChanges(workspacePath).catch((err: unknown) => {
      console.debug('acceptAllChanges failed', err);
    });
  }, [workspacePath]);

  const handlePublish = useCallback(() => {
    void window.scratchDesktop.pushWorkspaceChanges(workspacePath).catch((err: unknown) => {
      console.debug('pushWorkspaceChanges failed', err);
    });
  }, [workspacePath]);

  return (
    <Box
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 10,
        display: 'flex',
        backgroundColor: 'var(--bg-base)',
        border: '0.5px solid var(--fg-divider)',
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      {/* Left panel — record navigator */}
      <Box
        style={{
          width: 240,
          minWidth: 240,
          borderRight: '0.5px solid var(--fg-divider)',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: 'var(--bg-panel)',
        }}
      >
        <Box style={{ padding: '8px 12px', borderBottom: '0.5px solid var(--fg-divider)' }}>
          <Text12Medium c="var(--fg-muted)">Name</Text12Medium>
        </Box>
        <ScrollArea style={{ flex: 1 }}>
          {rows.map((row, i) => (
            <Box
              key={i}
              component="button"
              ref={i === selectedIndex ? selectedItemRef : undefined}
              onClick={() => onSelectIndex(i)}
              style={{
                display: 'block',
                width: '100%',
                padding: '6px 12px',
                border: 'none',
                borderLeft: i === selectedIndex ? '2px solid var(--mantine-color-blue-4)' : '2px solid transparent',
                backgroundColor: i === selectedIndex ? 'var(--bg-selected)' : 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <Text12Regular c={i === selectedIndex ? 'var(--fg-primary)' : 'var(--fg-secondary)'} lineClamp={1}>
                {getRecordName(row, titleColumnId)}
              </Text12Regular>
            </Box>
          ))}
        </ScrollArea>
      </Box>

      {/* Right panel — record detail */}
      <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
        {/* Header */}
        <Box style={{ padding: '8px 12px', borderBottom: '0.5px solid var(--fg-divider)' }}>
          <Group
            justify="flex-end"
            align="center"
            wrap="nowrap"
            gap={6}
            style={{ paddingBottom: 8, marginBottom: 8, borderBottom: '0.5px solid var(--fg-divider)' }}
          >
            <Text12Regular c="var(--fg-muted)">
              {selectedIndex + 1} of {rows.length}
            </Text12Regular>
            <IconButtonGhost onClick={handlePrev} disabled={selectedIndex === 0}>
              <StyledLucideIcon Icon={ChevronUp} size="sm" />
            </IconButtonGhost>
            <IconButtonGhost onClick={handleNext} disabled={selectedIndex === rows.length - 1}>
              <StyledLucideIcon Icon={ChevronDown} size="sm" />
            </IconButtonGhost>
            <IconButtonGhost onClick={onClose}>
              <StyledLucideIcon Icon={X} size="sm" />
            </IconButtonGhost>
          </Group>

          <Group justify="space-between" align="center" wrap="nowrap">
            <TextTitle2 lineClamp={1} style={{ flex: 1, minWidth: 0 }}>
              {recordName}
            </TextTitle2>

            <Group gap={6} align="center" wrap="nowrap">
              <ButtonSecondaryOutline size="compact-xs" onClick={handleAcceptAll}>
                Accept all
              </ButtonSecondaryOutline>
              <ButtonSecondaryOutline size="compact-xs" onClick={handlePublish}>
                Reject all
              </ButtonSecondaryOutline>
              <ButtonSecondaryOutline
                size="compact-xs"
                onClick={() => setViewRaw((v) => !v)}
                style={
                  viewRaw
                    ? { backgroundColor: 'var(--mantine-color-blue-0)', borderColor: 'var(--mantine-color-blue-4)' }
                    : undefined
                }
              >
                View Raw
              </ButtonSecondaryOutline>
            </Group>
          </Group>
        </Box>

        {/* Content */}
        {loading && (
          <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Loader size="sm" />
          </Box>
        )}

        {!loading && rawData && !viewRaw && <RecordFieldsGrid data={rawData} />}

        {!loading && rawData && viewRaw && (
          <ScrollArea style={{ flex: 1 }}>
            <Box style={{ padding: 12 }}>
              <TextMono12Regular component="pre" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>
                {JSON.stringify(rawData, null, 2)}
              </TextMono12Regular>
            </Box>
          </ScrollArea>
        )}

        {!loading && !rawData && (
          <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Text12Regular c="dimmed">No data available</Text12Regular>
          </Box>
        )}
      </Stack>
    </Box>
  );
});
