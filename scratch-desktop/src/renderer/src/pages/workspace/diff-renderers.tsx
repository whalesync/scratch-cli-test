import { ButtonSecondaryGhost } from '@/components/base/buttons';
import { ActionIcon, Box, Stack, Tooltip } from '@mantine/core';
import { diffWordsWithSpace } from 'diff';
import type { LucideIcon } from 'lucide-react';
import { Undo2 } from 'lucide-react';
import { memo, useMemo } from 'react';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import {
  DIFF_REMOVED_BG,
  DIFF_REMOVED_FG,
  DIFF_TEXT_STYLE,
  getAddedBg,
  type FieldValueDiffKind,
} from './field-value-types';

const ACTION_BUTTON_SIZE = 24;

/** Left side of a side-by-side diff: shows unchanged text + removed words highlighted in red. */
export const SideBySideCurrentDiff = memo(function SideBySideCurrentDiff({
  fromValue,
  value,
}: {
  fromValue: string;
  value: string;
}) {
  const changes = useMemo(() => diffWordsWithSpace(fromValue, value), [fromValue, value]);
  return (
    <Box style={{ padding: '8px 12px', minWidth: 0, color: 'var(--fg-primary)', ...DIFF_TEXT_STYLE }}>
      {changes.map((change, index) => {
        if (change.added) return null;
        if (change.removed) {
          return (
            <span
              key={index}
              style={{
                color: DIFF_REMOVED_FG,
                textDecoration: 'line-through',
                backgroundColor: DIFF_REMOVED_BG,
                boxDecorationBreak: 'clone',
                WebkitBoxDecorationBreak: 'clone',
              }}
            >
              {change.value}
            </span>
          );
        }
        return <span key={index}>{change.value}</span>;
      })}
    </Box>
  );
});

/** Right side of a side-by-side diff: shows unchanged text + added words highlighted. */
export const SideBySideNewDiff = memo(function SideBySideNewDiff({
  fromValue,
  value,
  diffKind,
}: {
  fromValue: string;
  value: string;
  diffKind: FieldValueDiffKind;
}) {
  const changes = useMemo(() => diffWordsWithSpace(fromValue, value), [fromValue, value]);
  const addedBg = getAddedBg(diffKind);
  return (
    <Box style={{ padding: '8px 12px', minWidth: 0, color: 'var(--fg-primary)', ...DIFF_TEXT_STYLE }}>
      {changes.map((change, index) => {
        if (change.removed) return null;
        if (change.added) {
          return (
            <span
              key={index}
              style={{
                color: 'var(--modified-needs-review-stroke)',
                backgroundColor: addedBg,
                boxDecorationBreak: 'clone',
                WebkitBoxDecorationBreak: 'clone',
              }}
            >
              {change.value}
            </span>
          );
        }
        return <span key={index}>{change.value}</span>;
      })}
    </Box>
  );
});

/** Combined side-by-side diff with a divider, used in the focused field view. */
export const SideBySideDiff = memo(function SideBySideDiff({
  fromValue,
  value,
  diffKind,
}: {
  fromValue: string;
  value: string;
  diffKind: FieldValueDiffKind;
}) {
  return (
    <Box style={{ display: 'grid', gridTemplateColumns: '1fr 1px 1fr' }}>
      <SideBySideCurrentDiff fromValue={fromValue} value={value} />
      <Box style={{ backgroundColor: 'var(--fg-divider)' }} />
      <SideBySideNewDiff fromValue={fromValue} value={value} diffKind={diffKind} />
    </Box>
  );
});

export const InlineWordsDiff = memo(function InlineWordsDiff({
  fromValue,
  value,
  diffKind,
}: {
  fromValue: string;
  value: string;
  diffKind: FieldValueDiffKind;
}) {
  const changes = useMemo(() => diffWordsWithSpace(fromValue, value), [fromValue, value]);
  const addedBg = getAddedBg(diffKind);
  return (
    <Box style={{ padding: '8px 12px', color: 'var(--fg-primary)', ...DIFF_TEXT_STYLE }}>
      {changes.map((change, index) => {
        if (change.removed) {
          return (
            <span
              key={index}
              style={{
                color: DIFF_REMOVED_FG,
                textDecoration: 'line-through',
                backgroundColor: DIFF_REMOVED_BG,
                boxDecorationBreak: 'clone',
                WebkitBoxDecorationBreak: 'clone',
              }}
            >
              {change.value}
            </span>
          );
        }
        if (change.added) {
          return (
            <span
              key={index}
              style={{
                color: 'var(--modified-needs-review-stroke)',
                backgroundColor: addedBg,
                boxDecorationBreak: 'clone',
                WebkitBoxDecorationBreak: 'clone',
              }}
            >
              {change.value}
            </span>
          );
        }
        return <span key={index}>{change.value}</span>;
      })}
    </Box>
  );
});

export function ReviewActionIcon({
  label,
  onClick,
  tone,
  icon,
}: {
  label: string;
  onClick: () => void;
  tone: 'approve' | 'reject' | 'discard' | 'secondary';
  icon: LucideIcon;
}) {
  const styles =
    tone === 'approve'
      ? {
          backgroundColor: 'var(--mantine-color-green-1)',
          color: 'var(--mantine-color-green-8)',
          border: '1px solid var(--mantine-color-green-3)',
        }
      : tone === 'reject'
        ? {
            backgroundColor: 'var(--mantine-color-red-1)',
            color: 'var(--mantine-color-red-8)',
            border: '1px solid var(--mantine-color-red-3)',
          }
        : tone === 'discard'
          ? {
              backgroundColor: 'var(--mantine-color-red-1)',
              color: 'var(--mantine-color-red-5)',
              border: '1px solid var(--mantine-color-red-2)',
            }
          : {
              backgroundColor: 'var(--bg-selected)',
              color: 'var(--fg-primary)',
              border: '1px solid var(--fg-divider)',
            };

  return (
    <Tooltip label={label} position="left" withArrow zIndex={10020}>
      <ActionIcon
        variant="transparent"
        size={ACTION_BUTTON_SIZE}
        radius={3}
        aria-label={label}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onClick}
        styles={{
          root: {
            ...styles,
            minWidth: ACTION_BUTTON_SIZE,
            minHeight: ACTION_BUTTON_SIZE,
            padding: 3,
            boxShadow: '0 1px 2px rgba(15, 23, 42, 0.08)',
            '&:hover': {
              filter: 'brightness(0.97)',
            },
          },
        }}
      >
        <span style={{ display: 'inline-flex', pointerEvents: 'none' }}>
          <StyledLucideIcon Icon={icon} size={14} strokeWidth={2.25} />
        </span>
      </ActionIcon>
    </Tooltip>
  );
}

/**
 * Field-level review action links, rendered as vertically stacked text buttons.
 *
 * - **unreviewed** fields: "Approve" (green) + "Reject" (red)
 * - **unpublished** (approved) fields: "Discard" (desaturated red)
 */
export function FieldReviewActions({
  diffKind,
  onApprove,
  onUndo,
}: {
  diffKind: FieldValueDiffKind;
  onApprove?: () => void;
  onUndo?: () => void;
}) {
  if (!onApprove && !onUndo) return null;

  if (diffKind === 'unreviewed') {
    return (
      <Stack gap={2} align="flex-end">
        {onApprove && (
          <ButtonSecondaryGhost size="compact-xs" c="green.8" onClick={onApprove}>
            Approve
          </ButtonSecondaryGhost>
        )}
        {onUndo && (
          <ButtonSecondaryGhost size="compact-xs" c="red.8" onClick={onUndo}>
            Reject
          </ButtonSecondaryGhost>
        )}
      </Stack>
    );
  }

  if (diffKind === 'unpublished' && onUndo) {
    return (
      <Tooltip label="Discard unpublished change" withArrow zIndex={10020}>
        <ActionIcon variant="subtle" size="sm" c="red.5" aria-label="Discard unpublished change" onClick={onUndo}>
          <Undo2 size={14} />
        </ActionIcon>
      </Tooltip>
    );
  }

  return null;
}
