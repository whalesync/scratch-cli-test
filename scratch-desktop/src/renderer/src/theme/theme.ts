import {
  ActionIcon,
  Button,
  Checkbox,
  createTheme,
  Divider,
  Kbd,
  Menu,
  Modal,
  Notification,
  Popover,
  Table,
  Title,
  Tooltip,
  virtualColor,
} from '@mantine/core';
import {
  CUSTOM_BLUE,
  CUSTOM_DARK,
  CUSTOM_GRAY_DARK,
  CUSTOM_GRAY_LIGHT,
  CUSTOM_RED_DARK,
  CUSTOM_RED_LIGHT,
  CUSTOM_YELLOW_DARK,
  CUSTOM_YELLOW_LIGHT,
} from './custom-colors';
import classes from './theme.module.css';
import { variantColorResolver } from './variant-color-resolver';

// Font families — using @fontsource packages instead of next/font/google
const FONT_FAMILY = 'Inter, -apple-system, BlinkMacSystemFont, sans-serif';
const FONT_FAMILY_MONOSPACE = 'Geist Mono, ui-monospace, Courier, monospace';
const FONT_FAMILY_HEADING = 'Funnel Display, Inter, -apple-system, BlinkMacSystemFont, sans-serif';

export const SCRATCH_MANTINE_THEME = createTheme({
  fontFamily: FONT_FAMILY,
  fontFamilyMonospace: FONT_FAMILY_MONOSPACE,

  cursorType: 'pointer',
  colors: {
    grayLight: CUSTOM_GRAY_LIGHT,
    grayDark: CUSTOM_GRAY_DARK,
    gray: virtualColor({
      name: 'gray',
      light: 'grayLight',
      dark: 'grayDark',
    }),

    redLight: CUSTOM_RED_LIGHT,
    redDark: CUSTOM_RED_DARK,
    red: virtualColor({
      name: 'red',
      light: 'redLight',
      dark: 'redDark',
    }),

    yellowLight: CUSTOM_YELLOW_LIGHT,
    yellowDark: CUSTOM_YELLOW_DARK,
    yellow: virtualColor({
      name: 'yellow',
      light: 'yellowLight',
      dark: 'yellowDark',
    }),

    blue: CUSTOM_BLUE,
    dark: CUSTOM_DARK,

    /** Use this color for all dev tools */
    devTool: virtualColor({
      name: 'devTool',
      light: 'violet',
      dark: 'violet',
    }),

    suggestion: virtualColor({
      name: 'suggestion',
      light: 'blue',
      dark: 'yellow',
    }),
  },

  primaryColor: 'yellowLight',
  primaryShade: { light: 6, dark: 6 },

  focusRing: 'auto',

  white: '#ffffff',
  black: '#000000',

  variantColorResolver: variantColorResolver,

  fontSizes: {
    xs: '12px',
    sm: '13px',
    md: '14px',
  },

  headings: {
    fontFamily: FONT_FAMILY_HEADING,
    fontWeight: '450',
    sizes: {
      h1: { fontSize: '24px', lineHeight: '160%', fontWeight: '500' },
      h2: { fontSize: '18px', lineHeight: '170%', fontWeight: '500' },
      h3: { fontSize: '16px', lineHeight: '150%', fontWeight: '500' },
      h4: { fontSize: '14px', lineHeight: '160%', fontWeight: '500' },
    },
  },

  spacing: {
    '2xs': '4px',
    xs: '8px',
    sm: '12px',
    md: '16px',
    lg: '24px',
    xl: '32px',
  },

  radius: {
    xs: '4px',
    sm: '6px',
    md: '8px',
    lg: '10px',
    full: '100%',
  },

  defaultRadius: '0px',

  components: {
    ActionIcon: ActionIcon.extend({
      classNames: { root: classes.actionIconRoot },
      defaultProps: {
        variant: 'subtle',
        size: 'md',
        color: 'var(--fg-muted)',
      },
    }),

    Button: Button.extend({
      classNames: { label: classes.buttonLabel },
    }),

    Checkbox: Checkbox.extend({
      defaultProps: { size: 'xs' },
      classNames: { input: classes.checkboxInput },
    }),

    Divider: Divider.extend({
      defaultProps: {
        color: 'var(--fg-divider)',
        size: 0.5,
      },
    }),

    Kbd: Kbd.extend({
      classNames: { root: classes.kbdRoot },
    }),
    Menu: Menu.extend({
      defaultProps: {
        shadow: 'md',
        width: 250,
      },
      classNames: {
        dropdown: classes.menuDropdown,
        item: classes.menuItem,
        divider: classes.menuDivider,
        itemSection: classes.menuItemSection,
        label: classes.menuLabel,
      },
    }),

    // Vertically center every modal by default. Mantine's stock placement is
    // top-aligned, which on Electron's large window sizes pushes the dialog
    // up into a corner — vertical centering reads as more deliberate and
    // matches what the user expects from native dialogs.
    Modal: Modal.extend({
      defaultProps: {
        centered: true,
      },
    }),

    Popover: Popover.extend({
      defaultProps: {
        withArrow: true,
        shadow: 'md',
        width: 250,
      },
      classNames: {
        dropdown: classes.popoverDropdown,
      },
    }),

    Table: Table.extend({
      classNames: { table: classes.table, thead: classes.tableThead, th: classes.tableTh, tbody: classes.tableTbody },
    }),

    Tooltip: Tooltip.extend({
      classNames: { tooltip: classes.tooltip },
      defaultProps: {
        withArrow: true,
        arrowSize: 8,
      },
    }),

    Title: Title.extend({
      defaultProps: {
        ff: FONT_FAMILY_HEADING,
        fw: 450,
      },
    }),

    Notification: Notification.extend({
      classNames: { root: classes.notificationRoot },
    }),
  },
});
