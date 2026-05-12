import { Group, Tooltip } from '@mantine/core';
import { LockIcon, type LucideIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { resolveIconSize } from './sizes';
import { StyledLucideIcon } from './StyledLucideIcon';

/**
 * Capability indicators for a record table or its linked folder.
 *
 * Display logic:
 * - If the folder/table is effectively read-only (user choice OR all three
 *   write capabilities disabled), render only the read-only lock icon.
 * - Otherwise render one icon per disabled write capability that is set,
 *   each with a diagonal slash to convey the "disabled" state.
 *
 * Icons live in a single horizontal group, all using the same calmer dimmed
 * treatment introduced for DEV-9923.
 */
export interface CapabilityIconsProps {
  /** User-chosen folder lock (DataFolder.options.readOnly). */
  readOnly?: boolean;
  /** Connector capability flags from TablePreview. */
  disabledCreates?: boolean;
  disabledUpdates?: boolean;
  disabledDeletes?: boolean;
  /** Icon size in pixels, or one of the Mantine sizes. Defaults to "sm". */
  size?: 'xs' | 'sm' | 'md' | number;
}

const ICON_COLOR = 'var(--fg-secondary)';
const SLASH_COLOR = 'var(--mantine-color-red-5)';

const READ_ONLY_TOOLTIP = 'Read-only — pull only, never published back';
const CREATES_TOOLTIP = 'Creates disabled — new records can’t be added';
const UPDATES_TOOLTIP = 'Updates disabled — existing records can’t be modified';
const DELETES_TOOLTIP = 'Deletes disabled — records can’t be removed';

function isFullyLocked(p: CapabilityIconsProps): boolean {
  return Boolean(p.disabledCreates && p.disabledUpdates && p.disabledDeletes);
}

/**
 * Renders a lucide icon overlaid with a diagonal slash, signalling the
 * capability is disabled. The slash uses currentColor so it inherits the
 * surrounding text color.
 */
function CrossedOutIcon({ Icon, size, label }: { Icon: LucideIcon; size: number; label: string }) {
  return (
    <Tooltip label={label} position="right">
      <span
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: size,
          height: size,
          color: ICON_COLOR,
        }}
      >
        <Icon size={size} color="currentColor" />
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            width: size * ((1 + Math.SQRT2) / 2),
            height: 1,
            background: SLASH_COLOR,
            transform: 'translate(-50%, -50%) rotate(45deg)',
            transformOrigin: 'center',
            pointerEvents: 'none',
          }}
        />
      </span>
    </Tooltip>
  );
}

export function CapabilityIcons(props: CapabilityIconsProps) {
  const { readOnly, disabledCreates, disabledUpdates, disabledDeletes, size = 'sm' } = props;
  const effectiveReadOnly = readOnly || isFullyLocked(props);
  const px = typeof size === 'number' ? size : resolveIconSize(size);

  if (effectiveReadOnly) {
    return (
      <Tooltip label={READ_ONLY_TOOLTIP} position="right">
        <span style={{ display: 'inline-flex', alignItems: 'center' }}>
          <StyledLucideIcon Icon={LockIcon} size={size} c={ICON_COLOR} />
        </span>
      </Tooltip>
    );
  }

  if (!disabledCreates && !disabledUpdates && !disabledDeletes) {
    return null;
  }

  return (
    <Group gap={4} wrap="nowrap">
      {disabledCreates && <CrossedOutIcon Icon={PlusIcon} size={px} label={CREATES_TOOLTIP} />}
      {disabledUpdates && <CrossedOutIcon Icon={PencilIcon} size={px} label={UPDATES_TOOLTIP} />}
      {disabledDeletes && <CrossedOutIcon Icon={Trash2Icon} size={px} label={DELETES_TOOLTIP} />}
    </Group>
  );
}
