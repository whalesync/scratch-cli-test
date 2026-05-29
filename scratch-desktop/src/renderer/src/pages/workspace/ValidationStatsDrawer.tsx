import { IconButtonGhost } from '@/components/base/buttons';
import { Box, Divider, Group, Loader, Modal, ScrollArea, Stack, Text, Tooltip } from '@mantine/core';
import { AlertTriangle } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { ValidationResultRow } from '../../../../shared/validation-types';
import { ValidationTooltipContent } from './ValidationIndicator';

// Mirrors ValidationStat from shared/validation-types.ts
type ValidationStat = {
  connection: string;
  folder_path: string;
  errors: number;
  warnings: number;
  records: number;
};

interface ValidationStatsDrawerProps {
  workspacePath: string;
}

function mapRows(rows: ValidationResultRow[]) {
  return rows.map((r) => ({
    level: r.level,
    message: r.message,
    description: r.description,
    fixable: r.fixable,
    validatorKind: r.validator_kind,
    fieldPath: r.field_path,
  }));
}

interface FolderKey {
  connection: string;
  folder_path: string;
}

export function ValidationStatsDrawer({ workspacePath }: ValidationStatsDrawerProps) {
  const [open, setOpen] = useState(false);
  const [stats, setStats] = useState<ValidationStat[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState<FolderKey | null>(null);
  const [sample, setSample] = useState<ValidationResultRow[]>([]);
  const [sampleLoading, setSampleLoading] = useState(false);

  const handleOpen = useCallback(async () => {
    setOpen(true);
    setSelectedFolder(null);
    setSample([]);
    setStatsLoading(true);
    try {
      const result = await window.scratchFiles.getValidationStats(workspacePath);
      setStats(result);
    } finally {
      setStatsLoading(false);
    }
  }, [workspacePath]);

  const handleSelectFolder = useCallback(
    async (key: FolderKey) => {
      setSelectedFolder(key);
      setSample([]);
      setSampleLoading(true);
      try {
        const folder = `${key.connection}/${key.folder_path}`;
        const result = await window.scratchFiles.getFolderValidationSample(workspacePath, folder);
        setSample(result);
      } finally {
        setSampleLoading(false);
      }
    },
    [workspacePath],
  );

  const byConnection = stats.reduce<Record<string, ValidationStat[]>>((acc, s) => {
    (acc[s.connection] ??= []).push(s);
    return acc;
  }, {});

  return (
    <>
      <Tooltip label="Validation issues">
        <IconButtonGhost size="compact-xs" c="violet.5" onClick={() => void handleOpen()}>
          <AlertTriangle size={14} />
        </IconButtonGhost>
      </Tooltip>

      <Modal
        opened={open}
        onClose={() => setOpen(false)}
        size={900}
        title={
          <Text fw={600} fz="sm">
            Validation issues
          </Text>
        }
        styles={{ body: { padding: 0 } }}
      >
        <Group align="stretch" style={{ height: 520 }}>
          {/* Left panel — folder tree with counts */}
          <ScrollArea w={220} h={520} style={{ borderRight: '1px solid var(--fg-divider)', flexShrink: 0 }}>
            <Box p="sm">
              {statsLoading && (
                <Group justify="center" pt="lg">
                  <Loader size="sm" />
                </Group>
              )}

              {!statsLoading && stats.length === 0 && (
                <Text fz="xs" c="dimmed" pt="sm">
                  No validation issues found.
                </Text>
              )}

              {!statsLoading &&
                Object.entries(byConnection).map(([connection, folderStats]) => (
                  <Stack key={connection} gap={2} mb="sm">
                    <Text fz={10} fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: '0.06em' }} px={4} py={4}>
                      {connection}
                    </Text>
                    {folderStats.map((s) => {
                      const isSelected =
                        selectedFolder?.connection === connection && selectedFolder.folder_path === s.folder_path;
                      return (
                        <Box
                          key={s.folder_path}
                          px={8}
                          py={5}
                          style={{
                            borderRadius: 6,
                            cursor: 'pointer',
                            background: isSelected ? 'var(--mantine-color-blue-0)' : 'transparent',
                          }}
                          onClick={() => void handleSelectFolder({ connection, folder_path: s.folder_path })}
                        >
                          <Group justify="space-between" gap={4}>
                            <Text
                              fz="xs"
                              style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                            >
                              {s.folder_path || '(root)'}
                            </Text>
                            <Group gap={4} style={{ flexShrink: 0 }}>
                              {s.records > 0 && (
                                <Text fz={10} fw={600} c="dimmed">
                                  {s.records}R
                                </Text>
                              )}
                              {s.warnings > 0 && (
                                <Text fz={10} fw={700} c="orange.6">
                                  {s.warnings}W
                                </Text>
                              )}
                              {s.errors > 0 && (
                                <Text fz={10} fw={700} c="red.7">
                                  {s.errors}E
                                </Text>
                              )}
                            </Group>
                          </Group>
                        </Box>
                      );
                    })}
                    <Divider mt={4} />
                  </Stack>
                ))}
            </Box>
          </ScrollArea>

          {/* Right panel — issue table */}
          <ScrollArea style={{ flex: 1 }} h={520}>
            <Box p="md">
              {!selectedFolder && (
                <Text fz="xs" c="dimmed">
                  Select a folder on the left to see its validation issues.
                </Text>
              )}

              {selectedFolder && sampleLoading && (
                <Group justify="center" pt="lg">
                  <Loader size="sm" />
                </Group>
              )}

              {selectedFolder && !sampleLoading && sample.length === 0 && (
                <Text fz="xs" c="dimmed">
                  No issues found for this folder.
                </Text>
              )}

              {selectedFolder && !sampleLoading && sample.length > 0 && (
                <Stack gap="xs">
                  <Text fz="xs" c="dimmed">
                    {selectedFolder.connection}/{selectedFolder.folder_path} — showing up to 20 issues
                  </Text>
                  <ValidationTooltipContent violations={mapRows(sample)} fullWidth showFieldColumn />
                </Stack>
              )}
            </Box>
          </ScrollArea>
        </Group>
      </Modal>
    </>
  );
}
