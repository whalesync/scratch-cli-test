import {
  Badge,
  Box,
  Button,
  Code,
  Group,
  Loader,
  Modal,
  Paper,
  Select,
  Stack,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import type { ConnectorAccount } from '@spinner/shared-types';
import { ChevronDownIcon, ChevronUpIcon, FolderIcon, RotateCcwIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CopyableCode } from '../../components/base/CopyableCode';
import { Text12Book, Text12Medium, Text12Regular, TextMono9Regular, TextTitle4 } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { useConnectorAccounts } from '../../hooks/use-connector-accounts';
import { usePublishPlan } from '../../hooks/use-publish-plan';
import { usePublishPlanOperation } from '../../hooks/use-publish-plan-operation';
import { usePublishPlanRecords } from '../../hooks/use-publish-plan-records';
import { absoluteDate, relativeTime } from '../../lib/date-format';
import { PHASE_ICONS } from '../../lib/publish-plan-icons';
import { publishPlanStatusBadgeColor } from '../../lib/publish-plan-status';
import { PublishPlanRecordsList } from './PublishPlanRecordsList';

type BulkRollbackScope =
  | { kind: 'all' }
  | { kind: 'filtered'; dataFolderId?: string; phase?: string; filename?: string };

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
  // Filename filter: debounce so the user doesn't fire a SWR fetch per
  // keystroke. 200ms feels responsive without spamming the server.
  const [filenameInput, setFilenameInput] = useState('');
  const [filename] = useDebouncedValue(filenameInput, 200);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [opModal, setOpModal] = useState<{ filePath: string; phase: string } | null>(null);
  const [bulkScope, setBulkScope] = useState<BulkRollbackScope | null>(null);
  const [bulkRunning, setBulkRunning] = useState(false);

  // Reset filter + page state whenever the active plan changes.
  useEffect(() => {
    setPage(1);
    setDataFolderId(null);
    setPhase(null);
    setFilenameInput('');
  }, [planId]);

  // Reset page whenever any filter changes — otherwise the user can sit
  // on page 3 of an empty filtered set.
  useEffect(() => {
    setPage(1);
  }, [filename]);

  const runBulkRollback = async () => {
    if (!workspacePath || !bulkScope) return;
    setBulkRunning(true);
    try {
      const filter =
        bulkScope.kind === 'filtered'
          ? {
              dataFolderId: bulkScope.dataFolderId,
              phase: bulkScope.phase,
              filename: bulkScope.filename,
            }
          : undefined;
      const res = await window.scratchFiles.revertPlan(workspacePath, planId, filter);
      if ('error' in res) throw new Error(res.error);
      notifications.show({
        title: 'Rolled back',
        message: `${res.total} record(s) — ${res.filesWritten} written, ${res.filesDeleted} deleted. Publish to apply.`,
        color: 'green',
      });
      setBulkScope(null);
    } catch (err) {
      console.debug('Bulk roll back failed', err);
      notifications.show({ title: 'Roll back failed', message: String(err), color: 'red' });
    } finally {
      setBulkRunning(false);
    }
  };

  const { records, isLoading: recordsLoading } = usePublishPlanRecords(workspaceId, planId, {
    page,
    pageSize: RECORDS_PAGE_SIZE,
    dataFolderId: dataFolderId ?? undefined,
    phase: phase ?? undefined,
    filename: filename || undefined,
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
        <Paper p="md" radius={0} style={{ minWidth: 315, flexShrink: 0, overflow: 'auto' }}>
          <Stack gap={4}>
            <InlineRow label="Date">
              <Text12Regular>
                {absoluteDate(publishPlan.createdAt)}{' '}
                <Text12Regular component="span" c="var(--fg-muted)">
                  · {relativeTime(publishPlan.createdAt)}
                </Text12Regular>
              </Text12Regular>
            </InlineRow>

            <InlineRow label="Status">
              <Badge color={publishPlanStatusBadgeColor(publishPlan.status)} size="sm" variant="light">
                {publishPlan.status}
              </Badge>
            </InlineRow>

            <InlineRow label="Connection">
              <Text12Regular c={connection ? undefined : 'var(--fg-muted)'}>
                {connection?.displayName ?? 'All connections'}
              </Text12Regular>
            </InlineRow>

            <InlineRow label="Affected Records">
              <Text12Regular fw={500}>{(records?.affectedRecords ?? 0).toLocaleString()}</Text12Regular>
            </InlineRow>

            <InlineRow label="Total Operations">
              <Text12Regular fw={500}>
                {(records?.totalOperations ?? publishPlan._count?.operations ?? 0).toLocaleString()}
              </Text12Regular>
            </InlineRow>

            {records?.filters.phases.length ? (
              <>
                <SectionLabel>Operation types</SectionLabel>
                {records.filters.phases.map(({ phase: p, count }) => (
                  <InlineRow
                    key={p}
                    indent
                    icon={PHASE_ICONS[p]?.Icon}
                    iconColor={PHASE_ICONS[p]?.color}
                    label={PHASE_ICONS[p]?.label ?? p}
                  >
                    <Text12Regular fw={500}>{count.toLocaleString()}</Text12Regular>
                  </InlineRow>
                ))}
              </>
            ) : null}

            {records?.filters.folders.length ? (
              <>
                <SectionLabel>Operations per table</SectionLabel>
                {records.filters.folders.map(({ id, path, count }) => (
                  <InlineRow key={id} indent icon={FolderIcon} iconColor="gray" label={path || '—'}>
                    <Text12Regular fw={500}>{count.toLocaleString()}</Text12Regular>
                  </InlineRow>
                ))}
              </>
            ) : null}

            {/* Bulk roll back is gated on (a) the workspace being local
                (workspacePath set) and (b) the plan being single-connector
                — the server endpoint rejects cross-connection plans. */}
            {workspacePath && publishPlan.connectorAccountId && (
              <Button
                size="xs"
                variant="default"
                leftSection={<StyledLucideIcon Icon={RotateCcwIcon} size={12} c="var(--mantine-color-red-7)" />}
                onClick={() => setBulkScope({ kind: 'all' })}
                mt="xs"
                styles={{ label: { color: 'var(--mantine-color-red-7)' } }}
              >
                Roll back all records
              </Button>
            )}

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
                <StackedField label="Plan ID">
                  <CopyableCode value={publishPlan.id} fontSize={9} />
                </StackedField>
                <StackedField label="Job ID">
                  {publishPlan.activeJobId ? (
                    <CopyableCode value={publishPlan.activeJobId} fontSize={9} />
                  ) : (
                    <Text12Regular c="var(--fg-muted)">—</Text12Regular>
                  )}
                </StackedField>
                <StackedField label="Main before publish">
                  {publishPlan.preMainCommitSha ? (
                    <CopyableCode value={publishPlan.preMainCommitSha} fontSize={9} />
                  ) : (
                    <Text12Regular c="var(--fg-muted)">—</Text12Regular>
                  )}
                </StackedField>
                <StackedField label="Dirty before publish">
                  {publishPlan.preDirtyCommitSha ? (
                    <CopyableCode value={publishPlan.preDirtyCommitSha} fontSize={9} />
                  ) : (
                    <Text12Regular c="var(--fg-muted)">—</Text12Regular>
                  )}
                </StackedField>
                <StackedField label="Main after publish">
                  {publishPlan.postMainCommitSha ? (
                    <CopyableCode value={publishPlan.postMainCommitSha} fontSize={9} />
                  ) : (
                    <Text12Regular c="var(--fg-muted)">—</Text12Regular>
                  )}
                </StackedField>
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
              <TextInput
                size="xs"
                placeholder="Filter by filename"
                value={filenameInput}
                onChange={(e) => setFilenameInput(e.currentTarget.value)}
                w={180}
              />
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
            <Group gap="xs" wrap="nowrap" align="center">
              <Text12Regular c="var(--fg-muted)">
                {(records?.total ?? 0).toLocaleString()} {records?.total === 1 ? 'record' : 'records'}
              </Text12Regular>
              {workspacePath && publishPlan.connectorAccountId && (records?.total ?? 0) > 0 && (
                <>
                  <Text12Regular c="var(--fg-muted)">·</Text12Regular>
                  <UnstyledButton
                    onClick={() =>
                      setBulkScope({
                        kind: 'filtered',
                        dataFolderId: dataFolderId ?? undefined,
                        phase: phase ?? undefined,
                        filename: filename || undefined,
                      })
                    }
                  >
                    <Group gap={3} wrap="nowrap" align="center">
                      <StyledLucideIcon Icon={RotateCcwIcon} size={11} c="var(--mantine-color-red-7)" />
                      <Text12Book style={{ color: 'var(--mantine-color-red-7)', textDecoration: 'underline' }}>
                        Roll back {(records?.total ?? 0).toLocaleString()} filtered{' '}
                        {records?.total === 1 ? 'record' : 'records'}
                      </Text12Book>
                    </Group>
                  </UnstyledButton>
                </>
              )}
            </Group>
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

      <Modal
        opened={!!bulkScope}
        onClose={() => (bulkRunning ? undefined : setBulkScope(null))}
        title={<Text12Medium>Roll back records</Text12Medium>}
        size="md"
        zIndex={1100}
        closeOnClickOutside={!bulkRunning}
        closeOnEscape={!bulkRunning}
      >
        <Stack gap="md">
          <Text12Regular>
            {bulkScope?.kind === 'all'
              ? `Every record changed by this publish will be rolled back to its pre-publish value. Records that this publish created will be deleted locally. You will need to publish the workbook for the changes to take effect.`
              : `All records currently matching the filter will be rolled back to their pre-publish values. Records the publish created will be deleted locally. You will need to publish the workbook for the changes to take effect.`}
          </Text12Regular>
          <Text12Regular c="var(--fg-muted)">
            The CLI re-fetches the affected record list when it runs, so the latest filter is what gets rolled back.
          </Text12Regular>
          <Group justify="flex-end" gap="xs">
            <Button size="xs" variant="default" onClick={() => setBulkScope(null)} disabled={bulkRunning}>
              Cancel
            </Button>
            <Button
              size="xs"
              color="red"
              loading={bulkRunning}
              onClick={() => void runBulkRollback()}
              leftSection={<StyledLucideIcon Icon={RotateCcwIcon} size={12} c="white" />}
            >
              Roll back
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}

/** Single-line metadata row with a dotted leader between label and value.
 * Used for every plan-detail field — top, table breakdowns, and the
 * advanced SHAs all share this layout. */
function InlineRow({
  label,
  icon,
  iconColor,
  indent,
  children,
}: {
  label: React.ReactNode;
  icon?: typeof ChevronDownIcon;
  iconColor?: string;
  indent?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Group gap={4} wrap="nowrap" align="baseline" style={{ paddingLeft: indent ? 12 : 0 }}>
      {icon && (
        <Box style={{ display: 'inline-flex', alignSelf: 'center' }}>
          <StyledLucideIcon Icon={icon} size={12} c={iconColor ? `var(--mantine-color-${iconColor}-7)` : undefined} />
        </Box>
      )}
      <Text12Regular c="var(--fg-muted)" style={{ whiteSpace: 'nowrap', flexShrink: 0 }}>
        {label}
      </Text12Regular>
      <Box
        style={{
          flex: 1,
          borderBottom: '1px dotted var(--fg-divider)',
          minWidth: 8,
          alignSelf: 'flex-end',
          marginBottom: 5,
        }}
      />
      <Box style={{ flexShrink: 0, textAlign: 'right' }}>{children}</Box>
    </Group>
  );
}

/** Section header used above table breakdowns. */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text12Regular c="var(--fg-muted)" tt="uppercase" fw={500} mt={4} style={{ letterSpacing: 0.4 }}>
      {children}
    </Text12Regular>
  );
}

/** Two-line variant — label above, full-width value below. Used in the
 * advanced section where values (SHAs, IDs) are too long for an inline
 * leader-dots layout. */
function StackedField({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return (
    <Stack gap={2}>
      <Text12Regular c="var(--fg-muted)" style={{ whiteSpace: 'nowrap' }}>
        {label}
      </Text12Regular>
      <Box>{children}</Box>
    </Stack>
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
          <Group gap="xs" wrap="nowrap" align="center">
            {meta?.Icon && (
              <Box style={{ display: 'inline-flex' }}>
                <StyledLucideIcon Icon={meta.Icon} size={16} c={`var(--mantine-color-${meta.color}-7)`} />
              </Box>
            )}
            <Text12Medium>{meta?.label ?? target.phase}</Text12Medium>
            <TextMono9Regular c="var(--fg-muted)">{target.filePath}</TextMono9Regular>
            {operation?.status && (
              <Badge size="sm" variant="light">
                {operation.status}
              </Badge>
            )}
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
          {operation.error && (
            <Code block style={{ fontSize: 11, color: 'var(--mantine-color-red-7)' }}>
              {operation.error}
            </Code>
          )}
          {operation.changedFields ? (
            <Code block style={{ fontSize: 11, maxHeight: 480, overflow: 'auto' }}>
              {JSON.stringify(operation.changedFields, null, 2)}
            </Code>
          ) : (
            <Text12Regular c="var(--fg-muted)">No changed fields.</Text12Regular>
          )}
        </Stack>
      )}
    </Modal>
  );
}
