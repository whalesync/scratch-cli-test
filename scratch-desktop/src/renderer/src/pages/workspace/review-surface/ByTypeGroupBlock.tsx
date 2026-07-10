import { ButtonSecondaryOutline } from '@/components/base/buttons';
import { Text12Regular, TextMono12Regular, TextTitle4 } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { Badge, Box, Group, UnstyledButton } from '@mantine/core';
import { CheckIcon } from 'lucide-react';
import { useState } from 'react';
import { ByTypeGroupRow } from './ByTypeGroupRow';
import type { ByTypeGroupModel } from './build-by-type-group-model';

/** How many rows a group shows before collapsing the rest behind a "Show all N" toggle. */
const MAX_VISIBLE_ROWS_PER_GROUP = 50;

interface ByTypeGroupBlockProps {
  group: ByTypeGroupModel;
  /** The group's bulk approve is running; disable the button and show a spinner. */
  isApproving: boolean;
  /** Bulk approve is unavailable (e.g. the folder's pending set is truncated past the load cap). */
  isBulkApproveDisabled: boolean;
  onApproveAll: () => void;
  onOpenRow: (filename: string) => void;
}

/**
 * One change-type block in the By-type view: a header (colour dot, title, record
 * count, and a right-aligned "Approve all N" bulk button) over the group's rows.
 * Long groups collapse to {@link MAX_VISIBLE_ROWS_PER_GROUP} rows with a "Show
 * all" expander — the block is a launcher into the drawer, not a reading surface.
 */
export function ByTypeGroupBlock({
  group,
  isApproving,
  isBulkApproveDisabled,
  onApproveAll,
  onOpenRow,
}: ByTypeGroupBlockProps) {
  const [showAllRows, setShowAllRows] = useState(false);

  const rowCount = group.rows.length;
  // "Approve all N" acts only on the still-unreviewed rows; when a group is fully approved the
  // action becomes an "All approved" badge (DEV-10687). The header count keeps counting all rows.
  const unreviewedCount = group.rows.filter((row) => !row.approved).length;
  const allApproved = rowCount > 0 && unreviewedCount === 0;
  const hasOverflow = rowCount > MAX_VISIBLE_ROWS_PER_GROUP;
  const visibleRows = showAllRows ? group.rows : group.rows.slice(0, MAX_VISIBLE_ROWS_PER_GROUP);

  // The title is tinted for the record-level groups (New / Removed / Needs
  // attention); a field group's title stays in the primary text colour.
  const titleColor = group.kind === 'field' ? 'var(--fg-primary)' : group.dotColorVar;

  return (
    <Box style={{ borderBottom: '0.5px solid var(--fg-divider)' }}>
      <Group gap={11} wrap="nowrap" style={{ padding: '13px 20px', background: 'var(--bg-panel)' }}>
        <Box style={{ width: 8, height: 8, flex: 'none', background: group.dotColorVar }} />
        <TextTitle4 c={titleColor}>{group.title}</TextTitle4>
        <TextMono12Regular c="var(--fg-muted)">
          {rowCount} record{rowCount === 1 ? '' : 's'}
        </TextMono12Regular>
        {/* Summary pill slot — deferred (DEV-10618 chunk H): a per-field-type
            summary such as "avg −10% · mostly lowered" for numeric columns. */}
        <Box style={{ flex: 1 }} />
        {allApproved ? (
          <Badge
            size="sm"
            radius="sm"
            leftSection={<StyledLucideIcon Icon={CheckIcon} size={12} />}
            styles={{
              root: {
                backgroundColor: 'var(--create-needs-review-bg)',
                color: 'var(--create-needs-review-stroke)',
                textTransform: 'none',
                fontWeight: 500,
              },
            }}
          >
            All approved
          </Badge>
        ) : (
          <ButtonSecondaryOutline
            size="compact-xs"
            onClick={onApproveAll}
            loading={isApproving}
            disabled={isBulkApproveDisabled || isApproving}
          >
            Approve all {unreviewedCount}
          </ButtonSecondaryOutline>
        )}
      </Group>

      <Box style={{ padding: '4px 20px 12px' }}>
        {visibleRows.map((row, index) => (
          <ByTypeGroupRow
            key={row.filename}
            groupKind={group.kind}
            row={row}
            isLastRow={index === visibleRows.length - 1}
            onOpen={() => onOpenRow(row.filename)}
          />
        ))}
        {hasOverflow && (
          <UnstyledButton onClick={() => setShowAllRows((shown) => !shown)} style={{ paddingTop: 8 }}>
            <Text12Regular c="var(--modified-needs-review-stroke)">
              {showAllRows ? 'Show fewer' : `Show all ${rowCount}`}
            </Text12Regular>
          </UnstyledButton>
        )}
      </Box>
    </Box>
  );
}
