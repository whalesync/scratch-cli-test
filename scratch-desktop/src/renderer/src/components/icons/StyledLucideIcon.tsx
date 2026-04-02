import { CSSProperties, getThemeColor, MantineSize, useMantineTheme } from '@mantine/core';
import { LucideIcon } from 'lucide-react';
import { JSX } from 'react';
import { resolveIconSize, resolveSpacing } from './sizes';

/**
 * Lucide icons don't know how to take mantine styling props, like size="sm" or color="blue.3".
 * This wraps the icon with proper styling to resolve the mantine-specific things.
 */
export const StyledLucideIcon = ({
  Icon,
  c,
  size,
  centerInText,
  ml,
  mr,
  mt,
  className,
  strokeWidth,
}: {
  Icon: LucideIcon;
  c?: string;
  size?: MantineSize | number;
  /** Set this if it is embedded in a run of text, to set the vertical alignment to be centered */
  centerInText?: true;
  ml?: MantineSize | number;
  mr?: MantineSize | number;
  mt?: MantineSize | number;
  className?: string;
  strokeWidth?: number;
}): JSX.Element => {
  const theme = useMantineTheme();
  const resolvedColor = c ? getThemeColor(c, theme) : undefined;
  const resolvedSize = size ? resolveIconSize(size) : undefined;

  // Extra manual style properties for common scenarios.
  const style: CSSProperties = {};
  if (centerInText) {
    style.display = 'inline-block';
    style.verticalAlign = 'baseline';
    style.transform = 'translateY(13%)';
  }
  if (ml) {
    style.marginLeft = resolveSpacing(ml, theme);
  }
  if (mr) {
    style.marginRight = resolveSpacing(mr, theme);
  }
  if (mt) {
    style.marginTop = resolveSpacing(mt, theme);
  }
  if (resolvedSize) {
    style.minWidth = resolvedSize;
    style.minHeight = resolvedSize;
  }

  return (
    <Icon color={resolvedColor} size={resolvedSize} strokeWidth={strokeWidth} style={style} className={className} />
  );
};
