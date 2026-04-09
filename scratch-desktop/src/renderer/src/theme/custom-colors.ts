import { MantineColorsTuple } from '@mantine/core';

// TODO: The design provides 12 shades, but mantine only takes 10 so i've dropped the first and last.

// Yellow palette derived from the highlight design tokens:
//   Fill: #FEFB8A  |  Border: #D4C800  |  Text: #3A3600
// Shade 6 is the primary (used for Mantine primaryShade).
// Text on yellow backgrounds should use --highlight-text or var(--fg-primary), not palette shades.
export const CUSTOM_YELLOW_LIGHT: MantineColorsTuple = [
  '#FFFEF5', // yellow/0 – tinted white
  '#FEFDE0', // yellow/1 – very light wash
  '#FEFB8A', // yellow/2 – highlight fill
  '#F5F542', // yellow/3 – hover fill
  '#FFFF66', // yellow/4 – logo yellow
  '#E6DC00', // yellow/5 – vivid
  '#D4C800', // yellow/6 – highlight border ← primaryShade
  '#B8AE00', // yellow/7 – hover border
  '#8C8500', // yellow/8 – deep
  '#000000', // yellow/9 – black text on yellow
];

export const CUSTOM_YELLOW_DARK: MantineColorsTuple = [
  '#1F1E0F', // yellow/0 – dark base
  '#2A2810', // yellow/1 – dark surface
  '#FEFB8A30', // yellow/2 – faint glow
  '#FEFB8A50', // yellow/3 – subtle glow
  '#FFFF6680', // yellow/4 – soft glow
  '#FFFF66AA', // yellow/5 – medium glow
  '#D4C800', // yellow/6 – highlight border ← primaryShade
  '#FEFB8A', // yellow/7 – highlight fill on dark
  '#FFFF66', // yellow/8 – logo yellow on dark
  '#FFFACC', // yellow/9 – high-contrast text on dark
];

export const CUSTOM_RED_LIGHT: MantineColorsTuple = [
  '#FFFCFB', // Figma red/1 (light)
  '#FFF8F6', // Figma red/2 (light)
  '#FF32001A', // Figma red/3 (light)
  '#FF360030', // Figma red/4 (light)
  // "#FF320042", // Figma red/5 (light)
  '#FF2C0057', // Figma red/6 (light)
  '#FF290070', // Figma red/7 (light)
  // "#F826008F", // Figma red/8 (light)
  '#FF2C08', // Figma red/9 (light)
  '#F10900', // Figma red/10 (light)
  '#E30000', // Figma red/11 (light)
  '#641F14', // Figma red/12 (light)
];

export const CUSTOM_RED_DARK: MantineColorsTuple = [
  '#221918', // Figma red/1 (dark)
  '#291C19', // Figma red/2 (dark)
  '#FF120033', // Figma red/3 (dark)
  '#FE00004A', // Figma red/4 (dark)
  // "#FD06005C", // Figma red/5 (dark)
  '#FD28066E', // Figma red/6 (dark)
  '#FF422487', // Figma red/7 (dark)
  // "#FE4C30B5", // Figma red/8 (dark)
  '#FF2C08', // Figma red/9 (dark)
  '#F00F00', // Figma red/10 (dark)
  '#FF917B', // Figma red/11 (dark)
  '#FFD0C6', // Figma red/12 (dark)
];

export const CUSTOM_GRAY_LIGHT: MantineColorsTuple = [
  '#F8F8F9', // Figma gray/1 (light)
  '#F1F1F3', // Figma gray/2 (light)
  '#0105140D', // Figma gray/3 (light)
  '#02051314', // Figma gray/4 (light)
  // '#0205131C', // Figma gray/5 (light)
  '#02051229', // Figma gray/6 (light)
  '#02051242', // Figma gray/7 (light)
  // '#02051252', // Figma gray/8 (light)
  '#8B8C92', // Figma gray/9 (light)
  '#808288', // Figma gray/10 (light)
  '#62646B', // Figma gray/11 (light)
  '#1C1F25', // Figma gray/12 (light)
];

export const CUSTOM_GRAY_DARK: MantineColorsTuple = [
  '#212326', // Figma gray/1 (dark)
  '#2B2D31', // Figma gray/2 (dark)
  '#E2E5EB17', // Figma gray/3 (dark)
  '#E2E5EB1C', // Figma gray/4 (dark)
  // '#E2E5EB24', // Figma gray/5 (dark)
  '#E2E8F333', // Figma gray/6 (dark)
  '#E1E6F042', // Figma gray/7 (dark)
  // '#DFE5F261', // Figma gray/8 (dark)
  '#70747C', // Figma gray/9 (dark)
  '#8E9298', // Figma gray/10 (dark)
  '#A6A9B0', // Figma gray/11 (dark)
  '#ECEEF0', // Figma gray/12 (dark)
];

// "Dark" is a built-in color that is used as background and foreground in dark mode.
// It is a spectrum from bright to dark.
// We mostly don't use these colors, and specify grey.X instead, which adjusts for light/dark mode.
// However it does sneak in some places, especially page background, so it needs sane defaults.
export const CUSTOM_DARK: MantineColorsTuple = [
  '#F5F6F9F5', // Figma gray/12 (dark)
  '#DCE0E999', // Figma gray/10 (dark)
  // '#DEE5F370', // Figma gray/9 (dark)
  '#DFE5F261', // Figma gray/8 (dark)
  // '#E1E6F042', // Figma gray/7 (dark)
  '#E2E8F333', // Figma gray/6 (dark)
  '#E2E5EB24', // Figma gray/5 (dark)
  '#E2E5EB1C', // Figma gray/4 (dark)
  '#E2E5EB17', // Figma gray/3 (dark)
  '#1A1C1F', // <------------------ Used as PAGE by mantine.
  '#1A1C1F',
  '#1A1C1F',
];

export const CUSTOM_BLUE: MantineColorsTuple = [
  '#e8f3ff',
  '#d1e2fe',
  '#a0c1fa',
  '#6c9ff7',
  '#4383f5',
  '#2c70f5',
  '#1f67f6',
  '#1257db',
  '#0551cf',
  '#0042ae',
];
