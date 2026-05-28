import { ActionIcon, Box, Group, Select, Stack } from '@mantine/core';
import { ChevronLeftIcon, ScrollTextIcon } from 'lucide-react';
import { useState } from 'react';
import { Text12Regular, Text16Medium } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { useConnectorAccounts } from '../../hooks/use-connector-accounts';
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
  const { connectorAccounts } = useConnectorAccounts(workspaceId);

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
              <Text12Regular c="var(--fg-secondary)">{detailPlanId.substring(0, 8)}…</Text12Regular>
            </>
          )}
        </Group>
        {/* List-view-only filter: when drilled into a single plan, the
            connection is fixed by the plan so the filter would be inert. */}
        {!detailPlanId && (connectorAccounts?.length ?? 0) > 0 && (
          <Select
            size="xs"
            placeholder="All connections"
            clearable
            value={connectionFilter}
            onChange={setConnectionFilter}
            data={(connectorAccounts ?? []).map((ca) => ({ value: ca.id, label: ca.displayName }))}
            w={220}
          />
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
          <PublishPlansList workspaceId={workspaceId} connectionFilter={connectionFilter} />
        )}
      </Box>
    </Stack>
  );
}
