import { Text13Regular } from '@/components/base/text';
import { Box, ScrollArea, Stack } from '@mantine/core';
import { ByTypeGroupBlock } from './ByTypeGroupBlock';
import { byTypeGroupKey, type ByTypeGroupModel } from './build-by-type-group-model';

interface ByTypeViewProps {
  groups: ByTypeGroupModel[];
  /** True when the folder has more pending changes than the load cap, so groups show only the first slice. */
  isTruncated: boolean;
  /** How many pending records were loaded into the view (the cap, when truncated). */
  loadedRecordCount: number;
  /** The folder-wide pending-record total (from `filterCounts.unreviewed`), shown in the truncation banner. */
  totalPendingRecordCount: number;
  /** Group keys (see `byTypeGroupKey`) whose bulk approve is currently in flight. */
  approvingGroupKeys: ReadonlySet<string>;
  onApproveAllForGroup: (group: ByTypeGroupModel) => void;
  onOpenGroupRow: (group: ByTypeGroupModel, filename: string) => void;
}

/**
 * The By-type grouped review surface (DEV-10618) — a DOM sibling to the canvas
 * data grid that lists a folder's pending changes grouped by what changed (one
 * block per modified column, plus New / Removed / Needs attention). It is purely
 * presentational: all data is grouped upstream by `buildByTypeGroupModel` and
 * every action is delegated to the host (`FolderDataGrid`), which owns the diff
 * data, the review-state ladder, and the detail drawer.
 */
export function ByTypeView({
  groups,
  isTruncated,
  loadedRecordCount,
  totalPendingRecordCount,
  approvingGroupKeys,
  onApproveAllForGroup,
  onOpenGroupRow,
}: ByTypeViewProps) {
  if (groups.length === 0) {
    return (
      <Box style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40 }}>
        <Text13Regular c="var(--fg-muted)">No pending changes to review in this folder.</Text13Regular>
      </Box>
    );
  }

  return (
    <ScrollArea style={{ flex: 1, minHeight: 0 }}>
      <Stack gap={0}>
        {isTruncated && (
          <Box
            style={{
              padding: '10px 20px',
              background: 'var(--modified-needs-review-bg)',
              borderBottom: '0.5px solid var(--fg-divider)',
            }}
          >
            <Text13Regular c="var(--fg-secondary)">
              Showing the first {loadedRecordCount.toLocaleString()} of {totalPendingRecordCount.toLocaleString()}{' '}
              pending changes. Bulk approve is disabled here — review the rest in the table view.
            </Text13Regular>
          </Box>
        )}
        {groups.map((group) => (
          <ByTypeGroupBlock
            key={byTypeGroupKey(group)}
            group={group}
            isApproving={approvingGroupKeys.has(byTypeGroupKey(group))}
            isBulkApproveDisabled={isTruncated}
            onApproveAll={() => onApproveAllForGroup(group)}
            onOpenRow={(filename) => onOpenGroupRow(group, filename)}
          />
        ))}
      </Stack>
    </ScrollArea>
  );
}
