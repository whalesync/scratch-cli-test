import { Text12Regular, Text13Regular } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { Box, Group } from '@mantine/core';
import { ArrowRightIcon } from 'lucide-react';
import type { ByTypeGroupModel, ByTypeGroupRowModel } from './build-by-type-group-model';

/** Fixed width of the leading status-glyph cell, keeping names aligned across rows. */
const STATUS_GLYPH_WIDTH = 16;
/** Fixed width of the record-name cell (matches the design's 200px name column). */
const RECORD_NAME_WIDTH = 200;

interface ByTypeGroupRowProps {
  groupKind: ByTypeGroupModel['kind'];
  row: ByTypeGroupRowModel;
  isLastRow: boolean;
  onOpen: () => void;
}

/**
 * One row inside a By-type group block: a leading status-glyph cell (kept blank
 * for pending — approved/rejected records leave the unreviewed set on refresh),
 * the record name, and a connector-agnostic preview. For a field group the
 * preview is a `from → to` redline read from the row's own approved/working
 * values; for record-level groups it is a muted label describing the change.
 * Clicking the row opens the detail drawer scoped to the group.
 */
export function ByTypeGroupRow({ groupKind, row, isLastRow, onOpen }: ByTypeGroupRowProps) {
  return (
    <Group
      gap={12}
      wrap="nowrap"
      onClick={onOpen}
      style={{
        padding: '9px 0',
        borderBottom: isLastRow ? 'none' : '0.5px solid var(--fg-divider)',
        cursor: 'pointer',
      }}
    >
      {/* Status glyph cell — reserved width so names stay aligned. */}
      <Box style={{ width: STATUS_GLYPH_WIDTH, flex: 'none' }} />

      <Text13Regular truncate w={RECORD_NAME_WIDTH} style={{ flex: 'none' }} c="var(--fg-primary)">
        {row.recordName}
      </Text13Regular>

      <Box style={{ flex: 1, minWidth: 0 }}>{renderPreview(groupKind, row)}</Box>

      <StyledLucideIcon Icon={ArrowRightIcon} size={14} c="var(--fg-muted)" />
    </Group>
  );
}

function renderPreview(groupKind: ByTypeGroupModel['kind'], row: ByTypeGroupRowModel) {
  if (groupKind === 'field') {
    return (
      <Text13Regular truncate c="var(--fg-secondary)">
        <Text13Regular component="del" c="var(--delete-needs-review-stroke)" style={{ textDecoration: 'line-through' }}>
          {row.fromDisplay || '—'}
        </Text13Regular>
        {'  →  '}
        <Text13Regular component="ins" c="var(--create-needs-review-stroke)" style={{ textDecoration: 'none' }}>
          {row.toDisplay || '—'}
        </Text13Regular>
      </Text13Regular>
    );
  }

  const label =
    groupKind === 'created'
      ? 'New record'
      : groupKind === 'deleted'
        ? 'Will be removed'
        : 'Invalid JSON — needs attention';
  return (
    <Text12Regular truncate c="var(--fg-muted)">
      {label}
    </Text12Regular>
  );
}
