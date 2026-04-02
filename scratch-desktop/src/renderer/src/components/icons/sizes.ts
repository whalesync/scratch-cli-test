import { MantineSize, MantineTheme } from '@mantine/core';

const ICON_SIZES: Record<MantineSize, number> = {
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
};

export function resolveIconSize(size: MantineSize | number): number {
  if (typeof size === 'number') {
    return size;
  }
  return ICON_SIZES[size];
}

export function resolveSpacing(size: MantineSize | number, theme: MantineTheme): string {
  if (typeof size === 'number') {
    return `${size}px`;
  }
  return theme.spacing[size];
}
