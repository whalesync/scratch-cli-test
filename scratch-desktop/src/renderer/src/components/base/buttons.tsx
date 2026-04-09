import { Box, Button, ButtonProps, Group, Stack } from '@mantine/core';
import { Cpu } from 'lucide-react';
import { ComponentPropsWithoutRef, ReactNode } from 'react';
import { StyledLucideIcon } from '../icons/StyledLucideIcon';
import customBordersClasses from '../theme/custom-borders.module.css';
import styles from './buttons.module.css';
import { Text13Book, Text13Regular } from './text';

export const ButtonPrimarySolid = Button.withProps({
  variant: 'filled',
  size: 'sm',
  color: 'var(--highlight-fill)',
  c: 'var(--highlight-text)',
  styles: {
    root: {
      border: '1.5px solid var(--highlight-border)',
      fontWeight: 500,
      '--button-hover': 'var(--highlight-fill-hover)',
    },
  },
});

export const ButtonPrimaryLight = Button.withProps({
  variant: 'filled',
  size: 'sm',
  color: 'var(--highlight-fill)',
  c: 'var(--highlight-text)',
  classNames: { root: customBordersClasses.cornerBorders },
  styles: {
    root: {
      border: '1.5px solid var(--highlight-border)',
      fontWeight: 500,
      '--button-hover': 'var(--highlight-fill-hover)',
    },
  },
});

export const ButtonSecondarySolid = Button.withProps({
  variant: 'filled',
  size: 'sm',
  color: 'gray.9', // fill
  c: 'background', // text
});

export const ButtonSecondaryOutline = Button.withProps({
  variant: 'outline',
  size: 'sm',
  color: 'var(--mantine-color-gray-5)',
  c: 'var(--mantine-color-gray-5)',
  bg: 'var(--bg-base)',
  classNames: { root: customBordersClasses.cornerBorders },
  styles: {
    section: { color: 'var(--fg-muted)' },
    inner: { color: 'var(--fg-primary)' },
  },
});

export const ButtonSecondaryGhost = Button.withProps({
  variant: 'subtle',
  size: 'sm',
  color: 'gray.9',
  c: 'gray.9',
  bd: 'none',
});

export const ButtonSecondaryInline = Button.withProps({
  w: 'min-content',
  size: 'compact-sm',
  variant: 'subtle',
  color: 'var(--fg-primary)',
  c: 'var(--fg-primary)',
  bd: 'none',
  styles: {
    section: { color: 'var(--fg-muted)' },
  },
});

export const ButtonDangerLight = Button.withProps({
  variant: 'light',
  size: 'sm',
  color: 'red.6',
  c: 'red.8',
  classNames: { root: customBordersClasses.cornerBorders },
});

export const IconButtonPrimaryOutline = Button.withProps({
  variant: 'filled',
  size: 'sm',
  color: 'var(--highlight-fill)',
  c: 'var(--highlight-text)',
  p: 0,
  classNames: { root: customBordersClasses.cornerBorders },
  styles: {
    root: {
      aspectRatio: '1',
      border: '1.5px solid var(--highlight-border)',
      fontWeight: 500,
      '--button-hover': 'var(--highlight-fill-hover)',
    },
  },
});

export const IconButtonOutline = Button.withProps({
  variant: 'outline',
  size: 'sm',
  color: 'gray.9',
  c: 'gray.6',
  p: 0,
  classNames: { root: `${customBordersClasses.cornerBorders} ${styles.IconButtonOutline}` },
});

export const IconButtonGhost = Button.withProps({
  variant: 'subtle',
  size: 'sm',
  color: 'var(--fg-muted)',
  c: 'var(--fg-muted)',
  p: 0,
  styles: {
    root: { aspectRatio: '1' },
  },
});

export const IconButtonInline = Button.withProps({
  variant: 'transparent',
  size: 'compact-sm',
  classNames: { root: styles.IconButtonInline },
});

export const IconButtonToolbar = Button.withProps({
  variant: 'outline',
  size: 'compact-xs',
  classNames: { root: styles.IconButtonToolbar },
});

// Compact buttons for toolbars and sidebars
export const ButtonCompactPrimary = Button.withProps({
  variant: 'filled',
  size: 'compact-xs',
  color: 'var(--highlight-fill)',
  c: 'var(--highlight-text)',
  classNames: { root: styles.ButtonCompactPrimary },
});

export const ButtonCompactDanger = Button.withProps({
  variant: 'light',
  size: 'compact-xs',
  classNames: { root: styles.ButtonCompactDanger },
});

export const ButtonCompactSecondary = Button.withProps({
  variant: 'light',
  size: 'compact-xs',
  classNames: { root: styles.ButtonCompactSecondary },
});

export const DevToolButton = Button.withProps({
  variant: 'outline',
  c: 'devTool',
  color: 'devTool',
  leftSection: <StyledLucideIcon Icon={Cpu} />,
  classNames: { root: customBordersClasses.cornerBorders },
});

export const DevToolButtonGhost = Button.withProps({
  variant: 'subtle',
  size: 'sm',
  c: 'devTool',
  color: 'devTool',
  leftSection: <StyledLucideIcon Icon={Cpu} />,
});
export interface ButtonWithDescriptionProps
  extends ButtonProps,
    Omit<ComponentPropsWithoutRef<'button'>, keyof ButtonProps> {
  icon?: ReactNode;
  title: string;
  description: string;
}

export const ButtonWithDescription = ({ icon, title, description, ...props }: ButtonWithDescriptionProps) => {
  return (
    <ButtonSecondaryOutline
      h="auto"
      py="sm"
      px="md"
      {...props}
      styles={{
        root: {
          display: 'flex',
          height: 'auto',
          alignItems: 'center',
        },
        label: {
          width: '100%',
          whiteSpace: 'normal',
        },
        inner: {
          justifyContent: 'flex-start',
        },
      }}
    >
      <Group align="flex-start" gap="md" wrap="nowrap" w="100%">
        {icon && (
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              height: 'calc(var(--mantine-font-size-sm) * 1.3)',
            }}
          >
            {icon}
          </Box>
        )}
        <Stack style={{ textAlign: 'left', flex: 1 }} gap={'xs'}>
          <Text13Regular size="sm" fw={500} c="var(--fg-primary)" lh={1.3}>
            {title}
          </Text13Regular>
          <Text13Book size="xs" c="var(--fg-muted" lh={1.3}>
            {description}
          </Text13Book>
        </Stack>
      </Group>
    </ButtonSecondaryOutline>
  );
};
