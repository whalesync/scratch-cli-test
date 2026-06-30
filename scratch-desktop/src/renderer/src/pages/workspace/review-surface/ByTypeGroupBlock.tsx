import { ButtonCompactPrimary } from '@/components/base/buttons';
import { Text12Regular, TextMono12Regular, TextTitle4 } from '@/components/base/text';
import { Box, Group, UnstyledButton } from '@mantine/core';
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
        {/* Override the default gold highlight border with a dark outline: the gold
            blends the yellow fill into the light-gray group header. */}
        <ButtonCompactPrimary
          onClick={onApproveAll}
          loading={isApproving}
          disabled={isBulkApproveDisabled || isApproving}
          styles={{ root: { borderColor: 'var(--fg-secondary)' } }}
        >
          Approve all {rowCount}
        </ButtonCompactPrimary>
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
