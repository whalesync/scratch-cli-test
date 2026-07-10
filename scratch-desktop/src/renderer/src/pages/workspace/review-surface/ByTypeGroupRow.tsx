import { Text12Regular, Text13Regular } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { Box, Group } from '@mantine/core';
import { ArrowRightIcon, CheckIcon } from 'lucide-react';
import { getWindowedWordDiffSegments } from '../../../../../shared/word-diff';
import type { ByTypeGroupModel, ByTypeGroupRowModel } from './build-by-type-group-model';
import { renderWordDiffSegments } from './word-diff-react';

/** Fixed width of the leading status-glyph cell, keeping names aligned across rows. */
const STATUS_GLYPH_WIDTH = 16;
/** Fixed width of the record-name cell (matches the design's 200px name column). */
const RECORD_NAME_WIDTH = 200;
/**
 * Upper bound (chars) of a "short" field value. Above it (M/L), the preview windows the diff around
 * the change with an ellipsis (matching the grid); at or below it, the plain `from → to` reads fine.
 */
const SHORT_FIELD_MAX_CHARS = 80;

interface ByTypeGroupRowProps {
  groupKind: ByTypeGroupModel['kind'];
  row: ByTypeGroupRowModel;
  isLastRow: boolean;
  onOpen: () => void;
}

/**
 * One row inside a By-type group block: a leading status-glyph cell (a green check
 * for approved-but-unpublished rows, blank otherwise — a rejected row leaves the
 * pending set on refresh, so ✕ is never rendered here), the record name, and a
 * connector-agnostic preview. For a field group the preview is a `from → to`
 * redline (windowed around the change for long-form values) read from the row's
 * own values; for record-level groups it is a muted label describing the change.
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
      {/* Status glyph cell — reserved width so names stay aligned; a green ✓ once approved. */}
      <Box style={{ width: STATUS_GLYPH_WIDTH, flex: 'none', display: 'flex', justifyContent: 'center' }}>
        {row.approved && <StyledLucideIcon Icon={CheckIcon} size={12} c="var(--create-needs-review-stroke)" />}
      </Box>

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
    // Long-form (M/L) values window the diff around the change with an ellipsis, matching the grid;
    // short values keep the plain `from → to` redline, which reads fine without truncation.
    const isLongForm = Math.max(row.fromDisplay.length, row.toDisplay.length) > SHORT_FIELD_MAX_CHARS;
    if (isLongForm) {
      return (
        <Text13Regular truncate c="var(--fg-secondary)">
          {renderWordDiffSegments(getWindowedWordDiffSegments(row.fromDisplay, row.toDisplay))}
        </Text13Regular>
      );
    }
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
