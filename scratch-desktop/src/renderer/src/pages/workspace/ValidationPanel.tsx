import { Text12Medium, Text12Regular, Text13Regular, Text16Medium } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import {
  ActionIcon,
  Alert,
  Avatar,
  Badge,
  Box,
  Divider,
  Group,
  Loader,
  ScrollArea,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  Tooltip,
} from '@mantine/core';
import {
  CircleDashedIcon,
  CircleIcon,
  CircleXIcon,
  ExternalLinkIcon,
  InfoIcon,
  ShieldCheck,
  ShieldCheckIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ColumnDefinition } from '../../../../shared/schema-columns';
import type {
  ValidationResultRow,
  ValidationStat,
  ValidatorConfig,
  ValidatorConfigEntry,
} from '../../../../shared/validation-types';
import { useWorkspaceUiStore } from '../../stores/workspace-ui-store';

interface ValidationPanelProps {
  workspacePath: string;
  stats: ValidationStat[];
  statsLoading: boolean;
  configs: ValidatorConfig[];
  configsLoading: boolean;
  onRefreshStats: () => void;
  onNavigateToField?: (folderPath: string, filename: string, fieldName: string) => void;
}

const SAMPLE_LIMIT = 100;

interface FolderKey {
  connection: string;
  folder_path: string;
}

function ProblemsTab({
  workspacePath,
  stats,
  statsLoading,
  validateEnabled,
  onNavigateToField,
}: {
  workspacePath: string;
  stats: ValidationStat[];
  statsLoading: boolean;
  validateEnabled: boolean;
  onNavigateToField?: (folderPath: string, filename: string, fieldName: string) => void;
}) {
  const [selectedFolder, setSelectedFolder] = useState<FolderKey | null>(null);
  const [sample, setSample] = useState<ValidationResultRow[]>([]);
  const [sampleLoading, setSampleLoading] = useState(false);
  const [columnDefs, setColumnDefs] = useState<ColumnDefinition[]>([]);

  const fieldDisplayNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const col of columnDefs) {
      if (col.id !== col.displayName) {
        map.set(col.id, col.displayName);
      }
    }
    return map;
  }, [columnDefs]);

  const handleSelectFolder = useCallback(
    async (key: FolderKey) => {
      setSelectedFolder(key);
      setSample([]);
      setColumnDefs([]);
      setSampleLoading(true);
      try {
        const folder = `${key.connection}/${key.folder_path}`;
        const folderPath = `${workspacePath}/${folder}`;
        const [result, metadata] = await Promise.all([
          window.scratchFiles.getFolderValidationSample(workspacePath, folder),
          window.scratchFiles.getFolderMetadata(folderPath, workspacePath).catch(() => null),
        ]);
        setSample(result);
        if (metadata?.columnDefinitions) {
          setColumnDefs(metadata.columnDefinitions);
        }
      } finally {
        setSampleLoading(false);
      }
    },
    [workspacePath],
  );

  if (!validateEnabled) {
    return (
      <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Stack align="center" gap="sm" py="xl" c="var(--fg-secondary)">
          <ShieldCheckIcon size={32} />
          <Text13Regular ta="center" maw={300}>
            Validation is turned off. Enable it with the toggle above to see problems across your workspace.
          </Text13Regular>
        </Stack>
      </Box>
    );
  }

  const byConnection = stats.reduce<Record<string, ValidationStat[]>>((acc, s) => {
    (acc[s.connection] ??= []).push(s);
    return acc;
  }, {});

  return (
    <Group align="stretch" style={{ flex: 1, minHeight: 0 }}>
      {/* Left panel -- folder tree with counts */}
      <ScrollArea w={330} style={{ borderRight: '1px solid var(--fg-divider)', flexShrink: 0 }}>
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
                  const bulletColor = s.errors > 0 ? 'var(--mantine-color-red-6)' : 'var(--mantine-color-orange-6)';
                  return (
                    <Box
                      key={s.folder_path}
                      px={8}
                      py={5}
                      style={{
                        borderRadius: 6,
                        cursor: 'pointer',
                        background: isSelected ? 'var(--highlight-fill)' : 'transparent',
                      }}
                      onClick={() => void handleSelectFolder({ connection, folder_path: s.folder_path })}
                    >
                      <Group gap={8} wrap="nowrap">
                        <CircleIcon size={8} fill={bulletColor} color={bulletColor} style={{ flexShrink: 0 }} />
                        <Text fz="xs" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {s.folder_path || '(root)'}
                        </Text>
                      </Group>
                    </Box>
                  );
                })}
                <Divider mt={4} />
              </Stack>
            ))}
        </Box>
      </ScrollArea>

      {/* Right panel -- issue table */}
      <ScrollArea flex={1} h="100%">
        {!selectedFolder && (
          <Box p="md">
            <Text fz="xs" c="dimmed">
              Select a folder on the left to see its validation issues.
            </Text>
          </Box>
        )}

        {selectedFolder && sampleLoading && (
          <Group justify="center" pt="lg">
            <Loader size="sm" />
          </Group>
        )}

        {selectedFolder && !sampleLoading && sample.length === 0 && (
          <Box p="md">
            <Text fz="xs" c="dimmed">
              No issues found for this folder.
            </Text>
          </Box>
        )}

        {selectedFolder && !sampleLoading && sample.length > 0 && (
          <Table fz="xs" horizontalSpacing={10} verticalSpacing={7} stickyHeader>
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ width: 40 }} />
                <Table.Th style={{ width: 140 }}>Field</Table.Th>
                <Table.Th>Message</Table.Th>
                <Table.Th style={{ width: 120 }}>Validator</Table.Th>
                {onNavigateToField && <Table.Th style={{ width: 40 }} />}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {sample.map((row, index) => (
                <Table.Tr key={`${row.file_name}-${row.field_path}-${row.validator_kind}-${index}`}>
                  <Table.Td>
                    <Avatar color={row.level === 'error' ? 'red' : 'orange'} radius="sm" size="sm">
                      {row.level === 'error' && <CircleXIcon size={16} strokeWidth={2} />}
                      {row.level === 'warning' && <TriangleAlertIcon size={16} strokeWidth={2} />}
                    </Avatar>
                  </Table.Td>
                  <Table.Td>
                    <Text12Medium c="var(--fg-primary)" style={{ wordBreak: 'break-all' }}>
                      {fieldDisplayNames.get(row.field_path) ?? row.field_path ?? '-'}
                    </Text12Medium>
                  </Table.Td>
                  <Table.Td style={{ wordBreak: 'break-word' }}>
                    <Stack gap={3}>
                      <Text12Medium c="var(--fg-primary)">{row.message ?? 'No message'}</Text12Medium>
                      {row.description && (
                        <Text12Regular c="var(--fg-secondary)" style={{ lineHeight: 1.35 }}>
                          {row.description}
                        </Text12Regular>
                      )}
                    </Stack>
                  </Table.Td>
                  <Table.Td
                    style={{
                      color: 'var(--fg-muted)',
                      fontFamily: 'monospace',
                      fontSize: 11,
                      overflowWrap: 'anywhere',
                    }}
                  >
                    {formatValidatorName(row.validator_kind)}
                  </Table.Td>
                  {onNavigateToField && (
                    <Table.Td>
                      {row.file_name && row.field_path && (
                        <Tooltip label="View field" position="left" withArrow>
                          <ActionIcon
                            variant="subtle"
                            size="sm"
                            color="gray"
                            onClick={() => {
                              const folderPath = `${workspacePath}/${selectedFolder.connection}/${selectedFolder.folder_path}`;
                              onNavigateToField(folderPath, row.file_name!, row.field_path);
                            }}
                          >
                            <ExternalLinkIcon size={14} />
                          </ActionIcon>
                        </Tooltip>
                      )}
                    </Table.Td>
                  )}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
        {sample.length >= SAMPLE_LIMIT && (
          <Box px="md" py="sm">
            <Text fz="xs" c="dimmed" ta="center">
              Showing the first {SAMPLE_LIMIT} issues. There may be more.
            </Text>
          </Box>
        )}
      </ScrollArea>
    </Group>
  );
}

const BUILTIN_VALIDATOR_DESCRIPTIONS: Record<string, string> = {
  required: 'Field must be present and non-empty',
  length: 'String length within a range',
  max_length: 'String must not exceed max length',
  enforce_schema: 'Record conforms to folder schema',
};

/** Group entries by target field, merging multi-field entries into each field. */
function groupEntriesByField(entries: ValidatorConfigEntry[]): Map<string, ValidatorConfigEntry[]> {
  const map = new Map<string, ValidatorConfigEntry[]>();
  const RECORD_LEVEL = '__record__';
  for (const entry of entries) {
    const targets = entry.field ? [entry.field] : (entry.fields ?? [RECORD_LEVEL]);
    for (const t of targets) {
      const list = map.get(t) ?? [];
      list.push(entry);
      map.set(t, list);
    }
  }
  return map;
}

function ConfigurationTab({
  configs,
  configsLoading,
  workspacePath,
}: {
  configs: ValidatorConfig[];
  configsLoading: boolean;
  workspacePath: string;
}) {
  const [columnDefsMap, setColumnDefsMap] = useState<Map<string, ColumnDefinition[]>>(new Map());

  // Load column definitions for each config folder (fire-and-forget on mount / config change).
  useEffect(() => {
    if (!workspacePath || configs.length === 0) return;
    let cancelled = false;
    const next = new Map<string, ColumnDefinition[]>();
    void Promise.all(
      configs.map(async (config) => {
        const folder = `${config.connection}/${config.folderPath}`;
        const folderPath = `${workspacePath}/${folder}`;
        try {
          const meta = await window.scratchFiles.getFolderMetadata(folderPath, workspacePath);
          if (meta?.columnDefinitions) {
            next.set(folder, meta.columnDefinitions);
          }
        } catch {
          // ignore — display names just won't be available
        }
      }),
    ).then(() => {
      if (!cancelled) setColumnDefsMap(next);
    });
    return () => {
      cancelled = true;
    };
  }, [configs, workspacePath]);

  if (configsLoading) {
    return (
      <Group justify="center" pt="xl">
        <Loader size="sm" />
      </Group>
    );
  }

  if (configs.length === 0) {
    return (
      <Stack gap="md" p="md" flex={1}>
        <Alert variant="light" color="gray" icon={<InfoIcon size={16} />} py="xs">
          <Text fz="xs" c="var(--fg-secondary)">
            Rules are read-only here. To add or change validation rules, ask your agent. It knows how to edit them for
            you.
          </Text>
        </Alert>
        <Stack align="center" justify="center" py="xl" flex={1} c="var(--fg-secondary)">
          <CircleDashedIcon size={32} />
          <Text13Regular ta="center" maw={300}>
            No validation rules have been created
          </Text13Regular>
        </Stack>
      </Stack>
    );
  }

  return (
    <ScrollArea style={{ flex: 1 }}>
      <Stack gap="lg" p="md">
        <Alert variant="light" color="gray" icon={<InfoIcon size={16} />} py="xs">
          <Text fz="xs" c="var(--fg-secondary)">
            Rules are read-only here. To add or change validation rules, ask your agent. It knows how to edit them for
            you.
          </Text>
        </Alert>

        {configs.map((config) => {
          const folderKey = `${config.connection}/${config.folderPath}`;
          const colDefs = columnDefsMap.get(folderKey) ?? [];
          const displayNameMap = new Map<string, string>(
            colDefs.filter((c) => c.id !== c.displayName).map((c) => [c.id, c.displayName]),
          );
          const resolveField = (f: string) => displayNameMap.get(f) ?? f;
          const grouped = groupEntriesByField(config.entries);

          return (
            <Box key={folderKey}>
              <Text12Medium c="var(--fg-secondary)" tt="uppercase" style={{ letterSpacing: '0.06em' }} mb={8}>
                {config.connection}
                {config.folderPath ? ` / ${config.folderPath}` : ''}
              </Text12Medium>

              {config.entries.length === 0 ? (
                <Text fz="xs" c="dimmed" fs="italic" pl={16}>
                  No validators configured
                </Text>
              ) : (
                <Stack gap={0}>
                  {Array.from(grouped, ([fieldKey, fieldEntries]) => {
                    const isRecordLevel = fieldKey === '__record__';
                    return fieldEntries.map((entry, idx) => (
                      <Group key={`${fieldKey}-${idx}`} gap={8} wrap="nowrap" align="flex-start" py={5} pl={16}>
                        {/* Field name — only on first row for this field */}
                        <Box style={{ width: 140, flexShrink: 0, paddingTop: 1 }}>
                          {idx === 0 && (
                            <Text12Medium c="var(--fg-primary)">
                              {isRecordLevel ? '(record)' : resolveField(fieldKey)}
                            </Text12Medium>
                          )}
                        </Box>

                        <Badge
                          variant="light"
                          color={BUILTIN_VALIDATOR_DESCRIPTIONS[entry.validator] ? 'gray' : 'violet'}
                          size="xs"
                          radius="sm"
                          styles={{ label: { textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.04em' } }}
                          style={{ flexShrink: 0 }}
                        >
                          {BUILTIN_VALIDATOR_DESCRIPTIONS[entry.validator] ? 'built-in' : 'custom'}
                        </Badge>

                        <Text12Medium c="var(--fg-primary)" style={{ flexShrink: 0 }}>
                          {formatValidatorName(entry.validator)}
                        </Text12Medium>

                        <Text12Regular c="var(--fg-muted)" fs="italic" style={{ whiteSpace: 'nowrap' }}>
                          {validatorDescription(entry)}
                        </Text12Regular>
                      </Group>
                    ));
                  })}
                </Stack>
              )}

              <Divider mt="sm" />
            </Box>
          );
        })}
      </Stack>
    </ScrollArea>
  );
}

function validatorDescription(entry: ValidatorConfigEntry): string {
  if (entry.note) return entry.note;
  const builtin = BUILTIN_VALIDATOR_DESCRIPTIONS[entry.validator];
  if (builtin) {
    // Append params inline for parameterized builtins.
    if (entry.params && Object.keys(entry.params).length > 0) {
      const paramStr = Object.entries(entry.params)
        .map(([k, v]) => `${k}: ${String(v)}`)
        .join(', ');
      return `${builtin} (${paramStr})`;
    }
    return builtin;
  }
  // Custom validators — show params if present.
  if (entry.params && Object.keys(entry.params).length > 0) {
    return Object.entries(entry.params)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(', ');
  }
  return '';
}

export function ValidationPanel({
  workspacePath,
  stats,
  statsLoading,
  configs,
  configsLoading,
  onNavigateToField,
}: ValidationPanelProps) {
  const validateEnabled = useWorkspaceUiStore((s) => s.validateEnabled);
  const setValidateEnabled = useWorkspaceUiStore((s) => s.setValidateEnabled);

  const totalProblems = stats.reduce((sum, s) => sum + s.errors + s.warnings, 0);

  return (
    <Stack
      gap={0}
      style={{
        flex: 1,
        minWidth: 0,
        backgroundColor: 'var(--bg-base)',
        border: '0.5px solid var(--fg-divider)',
        borderRadius: 4,
        overflow: 'hidden',
        display: 'flex',
      }}
    >
      {/* Header */}
      <Group
        style={{
          borderBottom: '0.5px solid var(--fg-divider)',
          flexShrink: 0,
        }}
        px={14}
        py={8}
        align="center"
        justify="space-between"
      >
        <Group gap={8} align="center">
          <StyledLucideIcon Icon={ShieldCheck} size={16} c="var(--fg-secondary)" />
          <Text16Medium c="var(--fg-primary)">Validation</Text16Medium>
        </Group>
        <Switch
          checked={validateEnabled}
          onChange={(e) => setValidateEnabled(e.currentTarget.checked)}
          label={validateEnabled ? 'On' : 'Off'}
          size="md"
          styles={{ label: { paddingLeft: 8, fontSize: 13 } }}
        />
      </Group>

      {/* Tabs */}
      <Tabs
        defaultValue="problems"
        style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}
        styles={{
          tab: {
            '&[data-active]': {
              background: 'var(--highlight-fill)',
              borderColor: 'var(--highlight-border)',
              fontWeight: 600,
            },
          },
        }}
      >
        <Tabs.List px={14}>
          <Tabs.Tab value="problems" fz="xs">
            Problems{validateEnabled && !statsLoading && totalProblems > 0 ? ` (${totalProblems})` : ''}
          </Tabs.Tab>
          <Tabs.Tab value="configuration" fz="xs">
            Rules
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="problems" style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <ProblemsTab
            workspacePath={workspacePath}
            stats={stats}
            statsLoading={statsLoading}
            validateEnabled={validateEnabled}
            onNavigateToField={onNavigateToField}
          />
        </Tabs.Panel>

        <Tabs.Panel value="configuration" style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <ConfigurationTab configs={configs} configsLoading={configsLoading} workspacePath={workspacePath} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}

function formatValidatorName(validatorKind: string): string {
  return validatorKind.replace(/[_-]+/g, ' ');
}
