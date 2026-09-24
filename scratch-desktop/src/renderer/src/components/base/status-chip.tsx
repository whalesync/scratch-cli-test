import { Box, Tooltip } from '@mantine/core';
import type { ReactNode } from 'react';
import styles from './status-chip.module.css';
import { Text12Medium } from './text';

/**
 * Semantic tone of a status chip. Drives the wash + stroke colour pair only, never
 * the shape, so every chip in a toolbar reads as the same class of thing.
 */
export type StatusChipTone = 'info' | 'success' | 'error';

/**
 * Reuses the app's established "status wash + stroke" token pairs — the same ones the
 * grid and the pull/publish progress modals already use — so a chip's colour means the
 * same thing wherever it shows up. (`info` is the blue the pull progress modal already
 * gives its own "in progress" chip.)
 *
 * Every tone is a tint. A chip must never be left un-tinted: Mantine renders a disabled
 * button with a flat grey fill, so a grey chip standing beside disabled toolbar actions
 * is indistinguishable from them — which is the exact confusion the chip exists to end.
 */
const STATUS_CHIP_TONE_TO_COLOR_PAIR: Record<StatusChipTone, { background: string; foreground: string }> = {
  info: { background: 'var(--modified-needs-review-bg)', foreground: 'var(--modified-needs-review-stroke)' },
  success: { background: 'var(--create-needs-review-bg)', foreground: 'var(--create-needs-review-stroke)' },
  error: { background: 'var(--delete-needs-review-bg)', foreground: 'var(--delete-needs-review-stroke)' },
};

interface StatusChipProps {
  /** Leading glyph — a spinner, a state icon, or nothing at all. */
  icon?: ReactNode;
  tone?: StatusChipTone;
  /**
   * Optional hover explanation. Owned by the chip rather than left to the call site so
   * the `<Tooltip>` always wraps a Mantine element it can attach a ref to.
   */
  tooltip?: string;
  /**
   * Supplying a handler makes the chip a real `<button>` that drills into detail, while
   * keeping the flat chip look. Status that happens to be clickable must still not
   * masquerade as one of the toolbar's actions.
   */
  onClick?: () => void;
  children: ReactNode;
}

/**
 * Ambient indicator of some state — a running job, a pending count — styled to read as a
 * report rather than as a control, so it can sit next to real buttons in a toolbar without
 * being mistaken for one.
 */
export function StatusChip({ icon, tone = 'info', tooltip, onClick, children }: StatusChipProps) {
  const { background, foreground } = STATUS_CHIP_TONE_TO_COLOR_PAIR[tone];
  const colorStyle = { backgroundColor: background, color: foreground };

  const content = (
    <>
      {icon !== undefined && <span className={styles.icon}>{icon}</span>}
      <Text12Medium component="span" c="inherit">
        {children}
      </Text12Medium>
    </>
  );

  const chip = onClick ? (
    <Box
      component="button"
      type="button"
      className={`${styles.chip} ${styles.clickable}`}
      style={colorStyle}
      onClick={onClick}
    >
      {content}
    </Box>
  ) : (
    <Box className={styles.chip} style={colorStyle}>
      {content}
    </Box>
  );

  return tooltip ? <Tooltip label={tooltip}>{chip}</Tooltip> : chip;
}
