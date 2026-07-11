import { ActionIcon, Box, Group, Select, Stack } from '@mantine/core';
import { ChevronLeftIcon, RefreshCwIcon, ScrollTextIcon } from 'lucide-react';
import { useState } from 'react';
import { ButtonSecondaryOutline } from '../../components/base/buttons';
import { Text12Regular, Text16Medium } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { useConnectorAccounts } from '../../hooks/use-connector-accounts';
import { usePublishPlan } from '../../hooks/use-publish-plan';
import { usePublishPlans } from '../../hooks/use-publish-plans';
import { absoluteDate } from '../../lib/date-format';
import { useWorkspaceUiStore } from '../../stores/workspace-ui-store';
import { PublishPlanDetailContent } from './PublishPlanDetailContent';
import { PublishPlansList } from './PublishPlansList';

interface PublishHistoryPanelProps {
  workspaceId: string;
  /** Absolute on-disk path to the workspace root, threaded through to the
   * publish-plan detail view's "Revert to this value" action. */
  workspacePath: string | null;
}

/**
 * Central-content panel hosting the Publish History list and the per-plan
 * detail drill-in. Mirrors the `ConnectionsPanel` chrome: same outer border
 * + radius + bg, same header padding (px=14, py=8) and typography
 * (`Text16Medium`). The sidebar Publish History button is highlighted while
 * this panel is open. The connection filter (list view only) lives in the
 * panel header; the records filters live inside the detail content's
 * records box.
 */
export function PublishHistoryPanel({ workspaceId, workspacePath }: PublishHistoryPanelProps) {
  const detailPlanId = useWorkspaceUiStore((s) => s.publishHistoryDetailPlanId);
  const setDetailPlanId = useWorkspaceUiStore((s) => s.setPublishHistoryDetailPlanId);
  const [connectionFilter, setConnectionFilter] = useState<string | null>(null);
  // Page state lives here (alongside the connection filter) so the Refresh
  // button's usePublishPlans call below and PublishPlansList's call share the
  // exact same SWR key. See the hook doc comment.
  const [page, setPage] = useState(1);
  const { connectorAccounts } = useConnectorAccounts(workspaceId);
  // SWR cache is shared with PublishPlansList — `refresh()` here triggers
  // a re-fetch the list will read from. Only used to drive the header's
  // Refresh button when on the list view. Args MUST match the list's call.
  const { isLoading: plansLoading, refresh: refreshPlans } = usePublishPlans(workspaceId, {
    page,
    connectorAccountId: connectionFilter ?? undefined,
  });
  // SWR dedupes with the detail content's fetch, so the breadcrumb pulls
  // from cache once the detail page has loaded.
  const { publishPlan: breadcrumbPlan } = usePublishPlan(workspaceId, detailPlanId ?? undefined);
  const breadcrumbConnectionName =
    breadcrumbPlan?.connectorAccount?.displayName ??
    (breadcrumbPlan?.connectorAccountId
      ? (connectorAccounts?.find((ca) => ca.id === breadcrumbPlan.connectorAccountId)?.displayName ?? null)
      : null);

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
      }}
    >
      {/* Header — mih matches `ConnectionsPanel` (where the inner xs button
          locks the height) so list and detail views render at the same chrome
          height regardless of right-side content. */}
      <Group
        style={{ borderBottom: '0.5px solid var(--fg-divider)', flexShrink: 0 }}
        px={14}
        py={8}
        mih={46}
        align="center"
        justify="space-between"
        wrap="nowrap"
      >
        <Group gap={8} align="center" wrap="nowrap" style={{ minWidth: 0 }}>
          {detailPlanId && (
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              onClick={() => setDetailPlanId(null)}
              aria-label="Back to Publish History"
            >
              <StyledLucideIcon Icon={ChevronLeftIcon} size={14} c="var(--fg-muted)" />
            </ActionIcon>
          )}
          <StyledLucideIcon Icon={ScrollTextIcon} size={16} c="var(--fg-secondary)" />
          <Text16Medium c="var(--fg-primary)">Publish History</Text16Medium>
          {detailPlanId && (
            <>
              <Text12Regular c="var(--fg-muted)">/</Text12Regular>
              <Text12Regular c="var(--fg-secondary)" style={{ whiteSpace: 'nowrap' }}>
                {breadcrumbPlan
                  ? `${absoluteDate(breadcrumbPlan.createdAt)}${breadcrumbConnectionName ? ` — ${breadcrumbConnectionName}` : ''}`
                  : '…'}
              </Text12Regular>
            </>
          )}
        </Group>
        {/* List-view-only controls: connection filter + refresh. When
            drilled into a single plan, the connection is fixed and the
            list isn't on screen, so neither makes sense. */}
        {!detailPlanId && (
          <Group gap="xs" wrap="nowrap">
            {(connectorAccounts?.length ?? 0) > 0 && (
              <Select
                size="xs"
                placeholder="All connections"
                clearable
                value={connectionFilter}
                onChange={(v) => {
                  setConnectionFilter(v);
                  setPage(1);
                }}
                data={(connectorAccounts ?? []).map((ca) => ({ value: ca.id, label: ca.displayName }))}
                w={220}
              />
            )}
            <ButtonSecondaryOutline
              size="xs"
              leftSection={<StyledLucideIcon Icon={RefreshCwIcon} size={12} />}
              loading={plansLoading}
              onClick={() => void refreshPlans()}
            >
              Refresh
            </ButtonSecondaryOutline>
          </Group>
        )}
      </Group>

      {/* Content area — `overflow: hidden` so the records box can own its
          own internal scroll while the surrounding chrome stays anchored. */}
      <Box style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {detailPlanId ? (
          <PublishPlanDetailContent
            workspaceId={workspaceId}
            planId={detailPlanId}
            workspacePath={workspacePath}
            onBack={() => setDetailPlanId(null)}
          />
        ) : (
          <PublishPlansList
            workspaceId={workspaceId}
            connectionFilter={connectionFilter}
            page={page}
            onPageChange={setPage}
          />
        )}
      </Box>
    </Stack>
  );
}
