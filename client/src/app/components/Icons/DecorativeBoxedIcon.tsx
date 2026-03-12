import { Center } from '@mantine/core';
import { LucideIcon } from 'lucide-react';
import customBordersClasses from '../theme/custom-borders.module.css';
import { StyledLucideIcon } from './StyledLucideIcon';

const SIZE = {
  lg: { outer: 72, inner: 36 },
  sm: { outer: 28, inner: 16 },
  xs: { outer: 20, inner: 13 },
};

/** Sometimes you want your icon in a little box when it's just there for decoration. */
export const DecorativeBoxedIcon = ({
  Icon,
  c = 'var(--fg-muted)',
  bg,
  size = 'sm',
}: {
  Icon: LucideIcon;
  c?: string;
  bg?: string;
  size?: 'lg' | 'sm' | 'xs';
}) => {
  const s = SIZE[size];
  return (
    <Center c={c} bg={bg} w={s.outer} h={s.outer} className={customBordersClasses.cornerBorders}>
      <StyledLucideIcon Icon={Icon} size={s.inner} />
    </Center>
  );
};
