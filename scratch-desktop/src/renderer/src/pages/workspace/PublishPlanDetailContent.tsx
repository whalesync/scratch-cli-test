import { Badge, Box, Code, Group, Loader, Modal, Paper, Select, Stack, Table, UnstyledButton } from '@mantine/core';
import type { ConnectorAccount } from '@spinner/shared-types';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CopyableCode } from '../../components/base/CopyableCode';
import { Text12Medium, Text12Regular, TextMono9Regular, TextTitle4 } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { useConnectorAccounts } from '../../hooks/use-connector-accounts';
import { usePublishPlan } from '../../hooks/use-publish-plan';
import { usePublishPlanOperation } from '../../hooks/use-publish-plan-operation';
import { usePublishPlanRecords } from '../../hooks/use-publish-plan-records';
import { absoluteDate, relativeTime } from '../../lib/date-format';
import { PHASE_ICONS } from '../../lib/publish-plan-icons';
import { publishPlanStatusBadgeColor } from '../../lib/publish-plan-status';
import { PublishPlanRecordsList } from './PublishPlanRecordsList';

interface PublishPlanDetailContentProps {
  workspaceId: string;
  planId: string;
  workspacePath: string | null;
  onBack: () => void;
}

const RECORDS_PAGE_SIZE = 20;

/**
 * Body of the publish plan detail view, sized to fill the panel content area.
 *
 * Layout: left card (plan metadata + operation type / per-table counts +
 * advanced commit SHAs) and right "records" card. The right card is a
 * full-height flex column with its own header (record count + filters),
 * scrollable middle (records list), and footer (pagination). The outer Group
 * itself takes `h: 100%` so both Papers stretch to fill the available height.
 */
export function PublishPlanDetailContent({
  workspaceId,
  planId,
  workspacePath,
  onBack,
}: PublishPlanDetailContentProps) {
  const { publishPlan, isLoading: publishPlanLoading } = usePublishPlan(workspaceId, planId);
  const { connectorAccounts } = useConnectorAccounts(workspaceId);
  const connection: { displayName: string; id?: string } | null =
    publishPlan?.connectorAccount ??
    connectorAccounts?.find((ca: ConnectorAccount) => ca.id === publishPlan?.connectorAccountId) ??
    null;

  const [page, setPage] = useState(1);
  const [dataFolderId, setDataFolderId] = useState<string | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [opModal, setOpModal] = useState<{ filePath: string; phase: string } | null>(null);

  // Reset filter + page state whenever the active plan changes.
  useEffect(() => {
    setPage(1);
    setDataFolderId(null);
    setPhase(null);
  }, [planId]);

  const { records, isLoading: recordsLoading } = usePublishPlanRecords(workspaceId, planId, {
    page,
    pageSize: RECORDS_PAGE_SIZE,
    dataFolderId: dataFolderId ?? undefined,
    phase: phase ?? undefined,
  });

  if (publishPlanLoading) {
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
        <Text12Regular c="var(--fg-muted)">Plan not found.</Text12Regular>
        <UnstyledButton onClick={onBack}>
          <Text12Regular c="var(--mantine-color-blue-6)">Back to Publish History</Text12Regular>
        </UnstyledButton>
      </Stack>
    );
  }

  const totalPages = records ? Math.max(1, Math.ceil(records.total / RECORDS_PAGE_SIZE)) : 1;

  return (
    <>
      <Group align="stretch" gap={0} wrap="nowrap" p={0} h="100%" style={{ width: '100%' }}>
        {/* Left card — plan metadata. No border (parent panel owns the
            outer chrome). Allowed to scroll internally if the Advanced
            section is expanded and pushes content past the panel. */}
        <Paper p="md" radius={0} style={{ minWidth: 280, flexShrink: 0, overflow: 'auto' }}>
          <Stack gap="md">
            <Field label="Date">
              <Text12Regular>{absoluteDate(publishPlan.createdAt)}</Text12Regular>
              <Text12Regular c="var(--fg-muted)">{relativeTime(publishPlan.createdAt)}</Text12Regular>
            </Field>

            <Field label="Status">
              <Badge color={publishPlanStatusBadgeColor(publishPlan.status)} size="sm" variant="light">
                {publishPlan.status}
              </Badge>
            </Field>

            <Field label="Connection">
              <Text12Regular c={connection ? undefined : 'var(--fg-muted)'}>
                {connection?.displayName ?? 'All connections'}
              </Text12Regular>
            </Field>

            <Field label="Operation types">
              {records?.filters.phases.length ? (
                <MiniCountTable
                  rows={records.filters.phases.map(({ phase: p, count }) => ({
                    key: p,
                    label: PHASE_ICONS[p]?.label ?? p,
                    Icon: PHASE_ICONS[p]?.Icon,
                    iconColor: PHASE_ICONS[p]?.color,
                    count,
                  }))}
                  total={publishPlan._count?.operations ?? 0}
                />
              ) : (
                <Text12Regular>{publishPlan._count?.operations ?? 0}</Text12Regular>
              )}
            </Field>

            {records?.filters.folders.length ? (
              <Field label="Operations per table">
                <MiniCountTable
                  rows={records.filters.folders.map(({ id, path, count }) => ({
                    key: id,
                    label: path || '—',
                    count,
                  }))}
                  total={publishPlan._count?.operations ?? 0}
                />
              </Field>
            ) : null}

            <Field label="Updated">
              <Text12Regular>{absoluteDate(publishPlan.updatedAt)}</Text12Regular>
              <Text12Regular c="var(--fg-muted)">{relativeTime(publishPlan.updatedAt)}</Text12Regular>
            </Field>

            <UnstyledButton onClick={() => setAdvancedOpen((v) => !v)} mt="sm">
              <Group gap={4}>
                <Text12Regular c="var(--fg-muted)" fw={500}>
                  {advancedOpen ? 'Hide advanced' : 'Show advanced'}
                </Text12Regular>
                <StyledLucideIcon Icon={advancedOpen ? ChevronUpIcon : ChevronDownIcon} size={12} c="var(--fg-muted)" />
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
                    <Text12Regular c="var(--fg-muted)">—</Text12Regular>
                  )}
                </Field>
                <Field label="Main before publish">
                  {publishPlan.preMainCommitSha ? (
                    <CopyableCode value={publishPlan.preMainCommitSha} />
                  ) : (
                    <Text12Regular c="var(--fg-muted)">—</Text12Regular>
                  )}
                </Field>
                <Field label="Dirty before publish">
                  {publishPlan.preDirtyCommitSha ? (
                    <CopyableCode value={publishPlan.preDirtyCommitSha} />
                  ) : (
                    <Text12Regular c="var(--fg-muted)">—</Text12Regular>
                  )}
                </Field>
                <Field label="Main after publish">
                  {publishPlan.postMainCommitSha ? (
                    <CopyableCode value={publishPlan.postMainCommitSha} />
                  ) : (
                    <Text12Regular c="var(--fg-muted)">—</Text12Regular>
                  )}
                </Field>
              </>
            )}
          </Stack>
        </Paper>

        {/* Right card — records. Full-height column: sticky header with
            count + filters, scrollable body, sticky footer with pagination.
            Only a left border — acts as the divider between the left card
            and this records table; the panel chrome owns the rest. */}
        <Paper
          p={0}
          radius={0}
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            borderLeft: '0.5px solid var(--fg-divider)',
          }}
        >
          <Group
            justify="space-between"
            align="center"
            wrap="nowrap"
            px="md"
            py="sm"
            style={{ borderBottom: '0.5px solid var(--fg-divider)', flexShrink: 0 }}
          >
            <Text12Medium>Records {records ? `(${records.total})` : ''}</Text12Medium>
            <Group gap="xs" wrap="nowrap">
              <Select
                size="xs"
                placeholder="All tables"
                clearable
                value={dataFolderId}
                onChange={(v) => {
                  setDataFolderId(v);
                  setPage(1);
                }}
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
                onChange={(v) => {
                  setPhase(v);
                  setPage(1);
                }}
                data={(records?.filters.phases ?? []).map(({ phase: p, count }) => ({
                  value: p,
                  label: `${PHASE_ICONS[p]?.label ?? p} (${count})`,
                }))}
                w={200}
              />
            </Group>
          </Group>

          <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            {recordsLoading ? (
              <Stack align="center" py="lg">
                <Loader size="sm" />
              </Stack>
            ) : (
              <PublishPlanRecordsList
                workspaceId={workspaceId}
                planId={planId}
                connectorAccountId={publishPlan.connectorAccountId}
                records={records?.data ?? []}
                onClickPhase={(filePath, p) => setOpModal({ filePath, phase: p })}
                workspacePath={workspacePath}
              />
            )}
          </Box>

          <Box
            style={{
              padding: '6px 12px',
              borderTop: '0.5px solid var(--fg-divider)',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexShrink: 0,
            }}
          >
            <Text12Regular c="var(--fg-muted)">
              {(records?.total ?? 0).toLocaleString()} {records?.total === 1 ? 'record' : 'records'}
            </Text12Regular>
            {totalPages > 1 && (
              <Group gap={4} align="center">
                <Box
                  component="button"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  style={{
                    padding: '1px 6px',
                    border: '1px solid var(--fg-divider)',
                    borderRadius: 4,
                    backgroundColor: 'transparent',
                    cursor: page <= 1 ? 'default' : 'pointer',
                    opacity: page <= 1 ? 0.4 : 1,
                  }}
                >
                  <Text12Regular>{'←'}</Text12Regular>
                </Box>
                <Text12Regular c="var(--fg-muted)">
                  {page.toLocaleString()} / {totalPages.toLocaleString()}
                </Text12Regular>
                <Box
                  component="button"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  style={{
                    padding: '1px 6px',
                    border: '1px solid var(--fg-divider)',
                    borderRadius: 4,
                    backgroundColor: 'transparent',
                    cursor: page >= totalPages ? 'default' : 'pointer',
                    opacity: page >= totalPages ? 0.4 : 1,
                  }}
                >
                  <Text12Regular>{'→'}</Text12Regular>
                </Box>
              </Group>
            )}
          </Box>
        </Paper>
      </Group>

      <OperationDetailModal
        workspaceId={workspaceId}
        planId={planId}
        target={opModal}
        onClose={() => setOpModal(null)}
      />
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack gap={2}>
      <Text12Regular c="var(--fg-muted)" tt="uppercase" fw={500} style={{ letterSpacing: 0.4 }}>
        {label}
      </Text12Regular>
      <Box>{children}</Box>
    </Stack>
  );
}

interface MiniRow {
  key: string;
  label: string;
  Icon?: typeof ChevronDownIcon;
  iconColor?: string;
  count: number;
}

function MiniCountTable({ rows, total }: { rows: MiniRow[]; total: number }) {
  return (
    <Table withRowBorders={false} verticalSpacing={2} mt={2}>
      <Table.Tbody>
        {rows.map(({ key, label, Icon, iconColor, count }) => (
          <Table.Tr key={key}>
            {Icon && (
              <Table.Td style={{ padding: '2px 0', width: 18 }}>
                <Box style={{ display: 'inline-flex' }}>
                  <StyledLucideIcon
                    Icon={Icon}
                    size={12}
                    c={iconColor ? `var(--mantine-color-${iconColor}-7)` : undefined}
                  />
                </Box>
              </Table.Td>
            )}
            <Table.Td style={{ padding: '2px 0' }}>
              <Text12Regular>{label}</Text12Regular>
            </Table.Td>
            <Table.Td style={{ padding: '2px 0', textAlign: 'right' }}>
              <Text12Regular fw={500}>{count}</Text12Regular>
            </Table.Td>
          </Table.Tr>
        ))}
        <Table.Tr>
          {rows[0]?.Icon !== undefined && (
            <Table.Td style={{ padding: '4px 0', borderTop: '1px solid var(--fg-divider)' }} />
          )}
          <Table.Td style={{ padding: '4px 0', borderTop: '1px solid var(--fg-divider)' }}>
            <Text12Regular c="var(--fg-muted)">Total</Text12Regular>
          </Table.Td>
          <Table.Td style={{ padding: '4px 0', textAlign: 'right', borderTop: '1px solid var(--fg-divider)' }}>
            <Text12Regular fw={500}>{total}</Text12Regular>
          </Table.Td>
        </Table.Tr>
      </Table.Tbody>
    </Table>
  );
}

function OperationDetailModal({
  workspaceId,
  planId,
  target,
  onClose,
}: {
  workspaceId: string;
  planId: string;
  target: { filePath: string; phase: string } | null;
  onClose: () => void;
}) {
  const { operation, isLoading } = usePublishPlanOperation(workspaceId, planId, target?.filePath, target?.phase);
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
              <Box style={{ display: 'inline-flex' }}>
                <StyledLucideIcon Icon={meta.Icon} size={16} c={`var(--mantine-color-${meta.color}-7)`} />
              </Box>
            )}
            <Text12Medium>{meta?.label ?? target.phase} — Changed fields</Text12Medium>
            <TextMono9Regular c="var(--fg-muted)">{target.filePath}</TextMono9Regular>
          </Group>
        ) : null
      }
    >
      {isLoading ? (
        <Stack align="center" py="lg">
          <Loader size="sm" />
        </Stack>
      ) : !operation ? (
        <Text12Regular c="var(--fg-muted)">Operation not found.</Text12Regular>
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
              <Text12Regular c="var(--fg-muted)" tt="uppercase" fw={500} mb={4} style={{ letterSpacing: 0.4 }}>
                Error
              </Text12Regular>
              <Code block style={{ fontSize: 11, color: 'var(--mantine-color-red-7)' }}>
                {operation.error}
              </Code>
            </Box>
          )}

          {!!operation.changedFields && (
            <Box>
              <Text12Regular c="var(--fg-muted)" tt="uppercase" fw={500} mb={4} style={{ letterSpacing: 0.4 }}>
                Changed fields
              </Text12Regular>
              <Code block style={{ fontSize: 11, maxHeight: 200, overflow: 'auto' }}>
                {JSON.stringify(operation.changedFields, null, 2)}
              </Code>
            </Box>
          )}

          <Box>
            <Text12Regular c="var(--fg-muted)" tt="uppercase" fw={500} mb={4} style={{ letterSpacing: 0.4 }}>
              Content
            </Text12Regular>
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
