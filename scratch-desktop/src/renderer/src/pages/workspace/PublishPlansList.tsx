import { Badge, Box, Button, Group, ScrollArea, Stack, Table, Tooltip, UnstyledButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { ConnectorAccount, PublishPlanEntity } from '@spinner/shared-types';
import {
  CloudUploadIcon,
  ExternalLinkIcon,
  FilePenLineIcon,
  MoveIcon,
  PlusCircleIcon,
  RefreshCwIcon,
  RepeatIcon,
  Trash2Icon,
} from 'lucide-react';
import { useState } from 'react';
import { ButtonSecondaryOutline } from '../../components/base/buttons';
import { Text12Medium, Text12Regular, TextMono12Regular } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { useConnectorAccounts } from '../../hooks/use-connector-accounts';
import { usePublishPlans } from '../../hooks/use-publish-plans';
import { absoluteDate, relativeTime } from '../../lib/date-format';
import { publishApi } from '../../lib/publish-api';
import { formatPhaseCount, jobStatusBadgeColor, publishPlanStatusBadgeColor } from '../../lib/publish-plan-status';
import { useWorkspaceUiStore } from '../../stores/workspace-ui-store';

const PHASE_COL_BORDER = '1px solid var(--mantine-color-gray-2)';
const PHASE_COL_STYLE = { width: 48, textAlign: 'center' as const, borderLeft: PHASE_COL_BORDER };

const JOB_PROGRESS_KEYS = ['assetUploads', 'edits', 'creates', 'deletes', 'backfills', 'renameFiles'] as const;

interface PublishPlansListProps {
  workspaceId: string;
  /** Connection filter owned by the panel header. Null means "All". */
  connectionFilter: string | null;
}

/**
 * Read-only history table of publish plans for a workspace. Polls every 2s
 * so in-flight plans surface progress without manual refresh. Each row links
 * to the publish-plan detail page. The connection filter is owned by the
 * surrounding `PublishHistoryPanel` header.
 */
export function PublishPlansList({ workspaceId, connectionFilter }: PublishPlansListProps) {
  const { publishPlans, isLoading, refresh } = usePublishPlans(workspaceId);
  const { connectorAccounts } = useConnectorAccounts(workspaceId);
  const setDetailPlanId = useWorkspaceUiStore((s) => s.setPublishHistoryDetailPlanId);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const connectorMap = new Map<string, ConnectorAccount>((connectorAccounts ?? []).map((ca) => [ca.id, ca]));
  const filtered = connectionFilter
    ? publishPlans.filter((p) => p.connectorAccountId === connectionFilter)
    : publishPlans;

  const handleDelete = async (plan: PublishPlanEntity) => {
    const confirmed = window.confirm('Delete this publish plan? This cannot be undone.');
    if (!confirmed) return;
    setDeletingId(plan.id);
    try {
      await publishApi.deletePublishPlan(workspaceId, plan.id);
      await refresh();
    } catch (err) {
      console.debug('Failed to delete publish plan', err);
      notifications.show({ title: 'Error', message: 'Failed to delete publish plan', color: 'red' });
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <Stack p="md" gap="sm">
      <Group justify="flex-end">
        <ButtonSecondaryOutline
          size="xs"
          leftSection={<StyledLucideIcon Icon={RefreshCwIcon} size={12} />}
          loading={isLoading}
          onClick={() => void refresh()}
        >
          Refresh
        </ButtonSecondaryOutline>
      </Group>

      <ScrollArea h={500}>
        <Table stickyHeader>
          <Table.Thead>
            <Table.Tr>
              <Table.Th style={{ width: 280 }}>Date</Table.Th>
              <Table.Th style={{ width: 110 }}>Status</Table.Th>
              <Table.Th>Connection</Table.Th>
              <Table.Th style={{ width: 180 }}>Author</Table.Th>
              <Table.Th style={PHASE_COL_STYLE}>
                <Tooltip label="Uploads" withArrow>
                  <Box style={{ display: 'inline-flex' }}>
                    <StyledLucideIcon Icon={CloudUploadIcon} size={12} c="var(--fg-muted)" />
                  </Box>
                </Tooltip>
              </Table.Th>
              <Table.Th style={PHASE_COL_STYLE}>
                <Tooltip label="Edits" withArrow>
                  <Box style={{ display: 'inline-flex' }}>
                    <StyledLucideIcon Icon={FilePenLineIcon} size={12} c="var(--fg-muted)" />
                  </Box>
                </Tooltip>
              </Table.Th>
              <Table.Th style={PHASE_COL_STYLE}>
                <Tooltip label="Creates" withArrow>
                  <Box style={{ display: 'inline-flex' }}>
                    <StyledLucideIcon Icon={PlusCircleIcon} size={12} c="var(--fg-muted)" />
                  </Box>
                </Tooltip>
              </Table.Th>
              <Table.Th style={PHASE_COL_STYLE}>
                <Tooltip label="Deletes" withArrow>
                  <Box style={{ display: 'inline-flex' }}>
                    <StyledLucideIcon Icon={Trash2Icon} size={12} c="var(--fg-muted)" />
                  </Box>
                </Tooltip>
              </Table.Th>
              <Table.Th style={PHASE_COL_STYLE}>
                <Tooltip label="Backfills" withArrow>
                  <Box style={{ display: 'inline-flex' }}>
                    <StyledLucideIcon Icon={RepeatIcon} size={12} c="var(--fg-muted)" />
                  </Box>
                </Tooltip>
              </Table.Th>
              <Table.Th style={PHASE_COL_STYLE}>
                <Tooltip label="Renames" withArrow>
                  <Box style={{ display: 'inline-flex' }}>
                    <StyledLucideIcon Icon={MoveIcon} size={12} c="var(--fg-muted)" />
                  </Box>
                </Tooltip>
              </Table.Th>
              <Table.Th style={{ width: 110, textAlign: 'right' }}>Actions</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {filtered.length === 0 ? (
              <Table.Tr>
                <Table.Td colSpan={11}>
                  <Text12Regular c="var(--fg-muted)" ta="center" py="md">
                    {connectionFilter ? 'No publish plans for this connection.' : 'No publish plans yet.'}
                  </Text12Regular>
                </Table.Td>
              </Table.Tr>
            ) : (
              filtered.map((p) => {
                const openDetail = () => setDetailPlanId(p.id);
                const connectionName = p.connectorAccountId
                  ? (connectorMap.get(p.connectorAccountId)?.displayName ?? p.connectorAccountId.substring(0, 8) + '…')
                  : 'All';
                return (
                  <Table.Tr key={p.id}>
                    <Table.Td>
                      <UnstyledButton
                        onClick={openDetail}
                        style={{ width: '100%', textAlign: 'left', display: 'block' }}
                      >
                        <Group gap={6} wrap="nowrap">
                          <Text12Medium>{absoluteDate(p.createdAt)}</Text12Medium>
                          <Text12Regular c="var(--fg-muted)">· {relativeTime(p.createdAt)}</Text12Regular>
                        </Group>
                      </UnstyledButton>
                    </Table.Td>
                    <Table.Td>
                      {p.job ? (
                        <Badge color={jobStatusBadgeColor(p.job.status)} size="sm" variant="outline">
                          {p.job.status}
                        </Badge>
                      ) : (
                        <Badge color={publishPlanStatusBadgeColor(p.status)} size="sm" variant="light">
                          {p.status}
                        </Badge>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text12Regular c={p.connectorAccountId ? undefined : 'var(--fg-muted)'}>
                        {connectionName}
                      </Text12Regular>
                    </Table.Td>
                    <Table.Td>
                      {p.author ? (
                        <Text12Regular>{p.author.name ?? p.author.email ?? 'Unknown'}</Text12Regular>
                      ) : (
                        <Text12Regular c="var(--fg-muted)">System</Text12Regular>
                      )}
                    </Table.Td>
                    {JOB_PROGRESS_KEYS.map((phaseKey) => {
                      const executedKey = `${phaseKey}Executed`;
                      const plannedKey = `${phaseKey}Planned`;
                      const pub = p.job?.progress as { publicProgress?: Record<string, number> } | undefined;
                      const completed = pub?.publicProgress?.[executedKey] ?? 0;
                      const total = pub?.publicProgress?.[plannedKey] ?? 0;
                      return (
                        <Table.Td key={phaseKey} style={{ textAlign: 'center', borderLeft: PHASE_COL_BORDER }}>
                          {total > 0 ? (
                            <TextMono12Regular c={completed < total ? 'blue' : completed > 0 ? 'green' : undefined}>
                              {formatPhaseCount(completed)}/{formatPhaseCount(total)}
                            </TextMono12Regular>
                          ) : completed > 0 ? (
                            <TextMono12Regular c="green">{formatPhaseCount(completed)}</TextMono12Regular>
                          ) : (
                            <TextMono12Regular c="var(--fg-muted)">—</TextMono12Regular>
                          )}
                        </Table.Td>
                      );
                    })}
                    <Table.Td>
                      <Group gap={6} wrap="nowrap" justify="flex-end">
                        <Tooltip label="Delete publish plan" position="top" withArrow>
                          <Button
                            size="xs"
                            variant="subtle"
                            color="red"
                            px={6}
                            loading={deletingId === p.id}
                            onClick={() => void handleDelete(p)}
                          >
                            <StyledLucideIcon Icon={Trash2Icon} size={14} />
                          </Button>
                        </Tooltip>
                        <Tooltip label="Open" position="top" withArrow>
                          <Button size="xs" variant="light" color="gray" px={6} onClick={openDetail}>
                            <StyledLucideIcon Icon={ExternalLinkIcon} size={14} />
                          </Button>
                        </Tooltip>
                      </Group>
                    </Table.Td>
                  </Table.Tr>
                );
              })
            )}
          </Table.Tbody>
        </Table>
      </ScrollArea>
    </Stack>
  );
}
