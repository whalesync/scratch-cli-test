import { Text, Title } from '@mantine/core';

/**
 * This file contains extensions of the Mantine Text component with preset props and styles that match the design system.
 *
 * When adding new text components, please follow the naming convention of Text<Usage><Size> (e.g. TextTitleSm)
 */

export const TextTitle1 = Title.withProps({
  order: 1,
  style: { letterSpacing: '-0.5%', lineHeight: '160%' },
});

export const TextTitle2 = Title.withProps({
  order: 2,
  style: { letterSpacing: '-2%', lineHeight: '27px' },
});

export const TextTitle3 = Title.withProps({
  order: 3,
  style: { letterSpacing: '-0.08px', lineHeight: '23px' },
});

export const TextTitle4 = Title.withProps({
  order: 4,
  style: { letterSpacing: '-0.07px', lineHeight: '22px' },
});

export const Text16Medium = Text.withProps({
  fz: '16px',
  fw: 475,
  style: { lineHeight: '20px', letterSpacing: '0%' },
});

export const Text16Regular = Text.withProps({
  fz: '16px',
  fw: 425,
  style: { lineHeight: '20px', letterSpacing: '0%' },
});

export const Text16Book = Text.withProps({
  fz: '16px',
  fw: 375,
  style: { lineHeight: '20px', letterSpacing: '0%' },
});

export const Text13Medium = Text.withProps({
  fz: '13px',
  fw: 475,
  style: { lineHeight: '19px', letterSpacing: '0%' },
});

export const Text13Regular = Text.withProps({
  fz: '13px',
  fw: 425,
  style: { lineHeight: '19px', letterSpacing: '0%' },
});

export const Text13Book = Text.withProps({
  fz: '13px',
  fw: 375,
  style: { lineHeight: '19px', letterSpacing: '0%' },
});

export const Text12Medium = Text.withProps({
  fz: '12px',
  fw: 475,
  style: { lineHeight: '18px', letterSpacing: '0%' },
});

export const Text12Regular = Text.withProps({
  fz: '12px',
  fw: 425,
  style: { lineHeight: '18px', letterSpacing: '0%' },
});

export const Text12Book = Text.withProps({
  fz: '12px',
  fw: 375,
  style: { lineHeight: '18px', letterSpacing: '0%' },
});

export const Text9Regular = Text.withProps({
  fz: '9px',
  fw: 425,
  style: { lineHeight: '12px', letterSpacing: '0%' },
});

export const TextMono13Regular = Text.withProps({
  ff: 'monospace',
  fz: '13px',
  fw: 400,
  style: { lineHeight: '19px', letterSpacing: '0.25px', paragraphSpacing: '8px' },
});

export const TextMono12Regular = Text.withProps({
  ff: 'monospace',
  fz: '12px',
  fw: 400,
  style: { lineHeight: '19px', letterSpacing: '0.25px', paragraphSpacing: '8px' },
});
