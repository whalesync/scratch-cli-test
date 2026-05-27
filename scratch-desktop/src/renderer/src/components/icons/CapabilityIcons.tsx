import { Group, Stack, Tooltip } from '@mantine/core';
import { InfoIcon, LockIcon, type LucideIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { resolveIconSize } from './sizes';
import { StyledLucideIcon } from './StyledLucideIcon';

export interface CapabilityIconsProps {
  readOnly?: boolean;
  disabledCreates?: boolean;
  disabledUpdates?: boolean;
  disabledDeletes?: boolean;
  size?: 'xs' | 'sm' | 'md' | number;
}

const ICON_COLOR = 'var(--mantine-color-dimmed)';
const SLASH_COLOR = 'var(--mantine-color-red-5)';

const READ_ONLY_TOOLTIP = 'Read-only — pull only, never published back';

function isFullyLocked(p: CapabilityIconsProps): boolean {
  return Boolean(p.disabledCreates && p.disabledUpdates && p.disabledDeletes);
}

function CrossedOutIcon({ Icon, size }: { Icon: LucideIcon; size: number }) {
  return (
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
  );
}

function CapabilityTooltipRow({ Icon, label, size }: { Icon: LucideIcon; label: string; size: number }) {
  return (
    <Group gap={6} wrap="nowrap" align="center">
      <CrossedOutIcon Icon={Icon} size={size} />
      <span>{label}</span>
    </Group>
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

  const tooltipContent = (
    <Stack gap={4}>
      {disabledCreates && <CapabilityTooltipRow Icon={PlusIcon} label="Creates not supported" size={px} />}
      {disabledUpdates && <CapabilityTooltipRow Icon={PencilIcon} label="Updates not supported" size={px} />}
      {disabledDeletes && <CapabilityTooltipRow Icon={Trash2Icon} label="Deletes not supported" size={px} />}
    </Stack>
  );

  return (
    <Tooltip label={tooltipContent} position="right" withArrow multiline>
      <span style={{ display: 'inline-flex', alignItems: 'center' }}>
        <StyledLucideIcon Icon={InfoIcon} size={size} c={ICON_COLOR} />
      </span>
    </Tooltip>
  );
}
