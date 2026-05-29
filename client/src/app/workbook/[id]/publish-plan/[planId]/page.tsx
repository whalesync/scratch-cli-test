'use client';

import { TextTitle4 } from '@/app/components/base/text';
import { useConnectorAccounts } from '@/hooks/use-connector-account';
import { usePublishPlan } from '@/hooks/use-publish-plan';
import { usePublishPlanOperation } from '@/hooks/use-publish-plan-operation';
import { usePublishPlanRecords } from '@/hooks/use-publish-plan-records';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { isExperimentEnabled } from '@/types/server-entities/users';
import { publishPlanStatusBadgeColor } from '@/utils/job-helpers';
import {
  Badge,
  Box,
  Code,
  Group,
  Loader,
  Modal,
  Pagination,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  Tooltip,
  UnstyledButton,
} from '@mantine/core';
import { useClipboard } from '@mantine/hooks';
import { PublishPlanStatus, WorkbookId } from '@spinner/shared-types';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CloudUploadIcon,
  CopyIcon,
  FilePenLineIcon,
  MoveIcon,
  PlusCircleIcon,
  RepeatIcon,
  Trash2Icon,
} from 'lucide-react';
import { useParams, useRouter } from 'next/navigation';
import { ReactNode, useEffect, useState } from 'react';
import { PublishPlanRecordsList } from './PublishPlanRecordsList';

dayjs.extend(relativeTime);

const PHASE_ICONS: Record<string, { Icon: typeof FilePenLineIcon; label: string; color: string }> = {
  edit: { Icon: FilePenLineIcon, label: 'Edit', color: 'blue' },
  create: { Icon: PlusCircleIcon, label: 'Create', color: 'green' },
  delete: { Icon: Trash2Icon, label: 'Delete', color: 'red' },
  backfill: { Icon: RepeatIcon, label: 'Backfill', color: 'grape' },
  'asset-upload': { Icon: CloudUploadIcon, label: 'Asset upload', color: 'cyan' },
  'rename-files': { Icon: MoveIcon, label: 'Rename', color: 'orange' },
};

function CopyableCode({ value }: { value: string }) {
  const clipboard = useClipboard({ timeout: 1500 });
  return (
    <Group gap={4} wrap="nowrap" align="center">
      <Code style={{ fontSize: 11, wordBreak: 'break-all', flex: 1, minWidth: 0 }}>{value}</Code>
      <Tooltip label={clipboard.copied ? 'Copied' : 'Copy'} withArrow>
        <UnstyledButton
          onClick={() => clipboard.copy(value)}
          style={{ color: 'var(--fg-muted)', flexShrink: 0, padding: 2, display: 'flex' }}
          aria-label="Copy to clipboard"
        >
          {clipboard.copied ? <CheckIcon size={12} color="var(--mantine-color-green-7)" /> : <CopyIcon size={12} />}
        </UnstyledButton>
      </Tooltip>
    </Group>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap={2}>
      <Text size="xs" c="dimmed" tt="uppercase" fw={500} style={{ letterSpacing: 0.4 }}>
        {label}
      </Text>
      <Box>{children}</Box>
    </Stack>
  );
}

export default function PublishPlanPage() {
  const params = useParams<{ id: string; planId: string }>();
  const router = useRouter();
  const workbookId = params.id as WorkbookId;
  const { user } = useScratchPadUser();
  const enabled = isExperimentEnabled('ENABLE_PUBLISH_HISTORY', user);

  const { publishPlan, isLoading } = usePublishPlan(workbookId, params.planId);
  const { connectorAccounts } = useConnectorAccounts(workbookId);
  const connection =
    publishPlan?.connectorAccount ?? connectorAccounts?.find((ca) => ca.id === publishPlan?.connectorAccountId) ?? null;

  const [page, setPage] = useState(1);
  const [dataFolderId, setDataFolderId] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [opModal, setOpModal] = useState<{ filePath: string; phase: string } | null>(null);
  const pageSize = 25;

  const { records, isLoading: recordsLoading } = usePublishPlanRecords(workbookId, params.planId, {
    page,
    pageSize,
    dataFolderId: dataFolderId ?? undefined,
    phase: phase ?? undefined,
  });

  useEffect(() => {
    if (user && !enabled) {
      router.replace(`/workbook/${params.id}/files`);
    }
  }, [user, enabled, router, params.id]);

  const handleDataFolderChange = (val: string | null) => {
    setDataFolderId(val);
    setPage(1);
  };
  const handlePhaseChange = (val: string | null) => {
    setPhase(val);
    setPage(1);
  };

  if (!enabled) {
    return null;
  }

  if (isLoading) {
    return (
      <Stack align="center" p="xl">
        <Loader size="sm" />
      </Stack>
    );
  }

  if (!publishPlan) {
    return (
      <Stack p="md">
        <TextTitle4>Publish Plan</TextTitle4>
        <Text c="dimmed">Plan not found.</Text>
      </Stack>
    );
  }

  const createdAt = dayjs(publishPlan.createdAt);
  const updatedAt = dayjs(publishPlan.updatedAt);
  const totalPages = records ? Math.max(1, Math.ceil(records.total / pageSize)) : 1;

  return (
    <Stack gap="md" p="md">
      <Group justify="space-between" align="flex-start">
        <Stack gap={4}>
          <TextTitle4>{createdAt.format('MMM D, YYYY h:mm A')}</TextTitle4>
          <Text size="sm" c="dimmed">
            {connection?.displayName ?? 'All connections'} · {createdAt.fromNow()}
          </Text>
        </Stack>
        <Badge color={publishPlanStatusBadgeColor(publishPlan.status as PublishPlanStatus)} size="lg" variant="light">
          {publishPlan.status}
        </Badge>
      </Group>

      <Group align="flex-start" gap="md" wrap="nowrap" style={{ width: '100%' }}>
        <Paper withBorder p="md" style={{ minWidth: 280, flexShrink: 0 }}>
          <Stack gap="md">
            <Field label="Operation types">
              {records?.filters.phases.length ? (
                <Table withRowBorders={false} verticalSpacing={2} mt={2}>
                  <Table.Tbody>
                    {records.filters.phases.map(({ phase, count }) => {
                      const meta = PHASE_ICONS[phase];
                      const Icon = meta?.Icon;
                      return (
                        <Table.Tr key={phase}>
                          <Table.Td style={{ padding: '2px 0', width: 18 }}>
                            {Icon && (
                              <Box c={`var(--mantine-color-${meta.color}-7)`} style={{ display: 'flex' }}>
                                <Icon size={12} />
                              </Box>
                            )}
                          </Table.Td>
                          <Table.Td style={{ padding: '2px 0' }}>
                            <Text size="xs">{meta?.label ?? phase}</Text>
                          </Table.Td>
                          <Table.Td style={{ padding: '2px 0', textAlign: 'right' }}>
                            <Text size="xs" fw={500}>
                              {count}
                            </Text>
                          </Table.Td>
                        </Table.Tr>
                      );
                    })}
                    <Table.Tr>
                      <Table.Td style={{ padding: '4px 0', borderTop: '1px solid var(--fg-divider)' }} />
                      <Table.Td style={{ padding: '4px 0', borderTop: '1px solid var(--fg-divider)' }}>
                        <Text size="xs" c="dimmed">
                          Total
                        </Text>
                      </Table.Td>
                      <Table.Td
                        style={{ padding: '4px 0', textAlign: 'right', borderTop: '1px solid var(--fg-divider)' }}
                      >
                        <Text size="xs" fw={500}>
                          {publishPlan._count?.operations ?? 0}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  </Table.Tbody>
                </Table>
              ) : (
                <Text size="sm">{publishPlan._count?.operations ?? 0}</Text>
              )}
            </Field>

            {records?.filters.folders.length ? (
              <Field label="Operations per table">
                <Table withRowBorders={false} verticalSpacing={2} mt={2}>
                  <Table.Tbody>
                    {records.filters.folders.map(({ id, path, count }) => (
                      <Table.Tr key={id}>
                        <Table.Td style={{ padding: '2px 0' }}>
                          <Text size="xs" ff="monospace" style={{ wordBreak: 'break-all' }}>
                            {path || '—'}
                          </Text>
                        </Table.Td>
                        <Table.Td style={{ padding: '2px 0', textAlign: 'right' }}>
                          <Text size="xs" fw={500}>
                            {count}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                    <Table.Tr>
                      <Table.Td style={{ padding: '4px 0', borderTop: '1px solid var(--fg-divider)' }}>
                        <Text size="xs" c="dimmed">
                          Total
                        </Text>
                      </Table.Td>
                      <Table.Td
                        style={{ padding: '4px 0', textAlign: 'right', borderTop: '1px solid var(--fg-divider)' }}
                      >
                        <Text size="xs" fw={500}>
                          {publishPlan._count?.operations ?? 0}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  </Table.Tbody>
                </Table>
              </Field>
            ) : null}

            <Field label="Created">
              <Text size="sm">{createdAt.format('MMM D, YYYY h:mm:ss A')}</Text>
              <Text size="xs" c="dimmed">
                {createdAt.fromNow()}
              </Text>
            </Field>

            <Field label="Updated">
              <Text size="sm">{updatedAt.format('MMM D, YYYY h:mm:ss A')}</Text>
              <Text size="xs" c="dimmed">
                {updatedAt.fromNow()}
              </Text>
            </Field>

            <UnstyledButton onClick={() => setAdvancedOpen((v) => !v)} mt="sm">
              <Group gap={4}>
                <Text size="xs" c="dimmed" fw={500}>
                  {advancedOpen ? 'Hide advanced' : 'Show advanced'}
                </Text>
                {advancedOpen ? (
                  <ChevronUpIcon size={12} color="var(--fg-muted)" />
                ) : (
                  <ChevronDownIcon size={12} color="var(--fg-muted)" />
                )}
              </Group>
            </UnstyledButton>

            {advancedOpen && (
              <>
                <Field label="Plan ID">
                  <CopyableCode value={publishPlan.id} />
                </Field>

                <Field label="Job ID">
                  {publishPlan.activeJobId ? (
                    <CopyableCode value={publishPlan.activeJobId} />
                  ) : (
                    <Text size="sm" c="dimmed">
                      —
                    </Text>
                  )}
                </Field>

                <Field label="Main before publish">
                  {publishPlan.preMainCommitSha ? (
                    <CopyableCode value={publishPlan.preMainCommitSha} />
                  ) : (
                    <Text size="sm" c="dimmed">
                      —
                    </Text>
                  )}
                </Field>

                <Field label="Dirty before publish">
                  {publishPlan.preDirtyCommitSha ? (
                    <CopyableCode value={publishPlan.preDirtyCommitSha} />
                  ) : (
                    <Text size="sm" c="dimmed">
                      —
                    </Text>
                  )}
                </Field>

                <Field label="Main after publish">
                  {publishPlan.postMainCommitSha ? (
                    <CopyableCode value={publishPlan.postMainCommitSha} />
                  ) : (
                    <Text size="sm" c="dimmed">
                      —
                    </Text>
                  )}
                </Field>
              </>
            )}
          </Stack>
        </Paper>

        <Paper withBorder p="md" style={{ flex: 1, minWidth: 0 }}>
          <Stack gap="sm">
            <Group justify="space-between" align="center">
              <Text size="sm" fw={500}>
                Records {records ? `(${records.total})` : ''}
              </Text>
              <Group gap="xs">
                <Select
                  size="xs"
                  placeholder="All tables"
                  clearable
                  value={dataFolderId}
                  onChange={handleDataFolderChange}
                  data={(records?.filters.folders ?? []).map((f) => ({
                    value: f.id,
                    label: `${f.path} (${f.count})`,
                  }))}
                  w={220}
                />
                <Select
                  size="xs"
                  placeholder="All operation types"
                  clearable
                  value={phase}
                  onChange={handlePhaseChange}
                  data={(records?.filters.phases ?? []).map(({ phase: p, count }) => ({
                    value: p,
                    label: `${PHASE_ICONS[p]?.label ?? p} (${count})`,
                  }))}
                  w={200}
                />
              </Group>
            </Group>

            {recordsLoading ? (
              <Stack align="center" py="lg">
                <Loader size="sm" />
              </Stack>
            ) : (
              <>
                <PublishPlanRecordsList
                  workbookId={workbookId}
                  planId={params.planId}
                  connectorAccountId={publishPlan.connectorAccountId}
                  records={records?.data ?? []}
                  preDirtyCommitSha={publishPlan.preDirtyCommitSha}
                  preMainCommitSha={publishPlan.preMainCommitSha}
                  postMainCommitSha={publishPlan.postMainCommitSha}
                  onClickPhase={(filePath, phase) => setOpModal({ filePath, phase })}
                />

                {totalPages > 1 && (
                  <Group justify="center" pt="sm">
                    <Pagination value={page} onChange={setPage} total={totalPages} size="sm" />
                  </Group>
                )}
              </>
            )}
          </Stack>
        </Paper>
      </Group>

      <OperationDetailModal
        workbookId={workbookId}
        planId={params.planId}
        target={opModal}
        onClose={() => setOpModal(null)}
      />
    </Stack>
  );
}

function OperationDetailModal({
  workbookId,
  planId,
  target,
  onClose,
}: {
  workbookId: WorkbookId;
  planId: string;
  target: { filePath: string; phase: string } | null;
  onClose: () => void;
}) {
  const { operation, isLoading } = usePublishPlanOperation(workbookId, planId, target?.filePath, target?.phase);
  const meta = target ? PHASE_ICONS[target.phase] : null;

  return (
    <Modal
      opened={!!target}
      onClose={onClose}
      size="lg"
      zIndex={1100}
      title={
        target ? (
          <Group gap="xs">
            {meta?.Icon && (
              <Box c={`var(--mantine-color-${meta.color}-7)`} style={{ display: 'flex' }}>
                <meta.Icon size={16} />
              </Box>
            )}
            <Text size="sm" fw={600}>
              {meta?.label ?? target.phase}
            </Text>
            <Text size="xs" c="dimmed" ff="monospace">
              {target.filePath}
            </Text>
          </Group>
        ) : null
      }
    >
      {isLoading ? (
        <Stack align="center" py="lg">
          <Loader size="sm" />
        </Stack>
      ) : !operation ? (
        <Text size="sm" c="dimmed">
          Operation not found.
        </Text>
      ) : (
        <Stack gap="md">
          <Group gap="xs">
            <Badge size="sm" variant="light">
              {operation.status}
            </Badge>
            {!!operation.changedFields && (
              <Badge size="sm" variant="light" color="grape">
                {Object.keys(operation.changedFields as Record<string, unknown>).length} changed field(s)
              </Badge>
            )}
          </Group>

          {operation.error && (
            <Box>
              <Text size="xs" tt="uppercase" c="dimmed" fw={500} mb={4} style={{ letterSpacing: 0.4 }}>
                Error
              </Text>
              <Code block style={{ fontSize: 11, color: 'var(--mantine-color-red-7)' }}>
                {operation.error}
              </Code>
            </Box>
          )}

          {!!operation.changedFields && (
            <Box>
              <Text size="xs" tt="uppercase" c="dimmed" fw={500} mb={4} style={{ letterSpacing: 0.4 }}>
                Changed fields
              </Text>
              <Code block style={{ fontSize: 11, maxHeight: 200, overflow: 'auto' }}>
                {JSON.stringify(operation.changedFields, null, 2)}
              </Code>
            </Box>
          )}

          <Box>
            <Text size="xs" tt="uppercase" c="dimmed" fw={500} mb={4} style={{ letterSpacing: 0.4 }}>
              Content
            </Text>
            <Code block style={{ fontSize: 11, maxHeight: 400, overflow: 'auto' }}>
              {operation.content === null || operation.content === undefined
                ? '—'
                : JSON.stringify(operation.content, null, 2)}
            </Code>
          </Box>
        </Stack>
      )}
    </Modal>
  );
}
