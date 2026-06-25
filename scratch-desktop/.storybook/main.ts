import type { StorybookConfig } from '@storybook/react-vite';
import { resolve } from 'path';
import { mergeConfig } from 'vite';
import { sharedTypesSourceAliases } from '../shared-types-source-aliases';

// Storybook is a standalone tool wired to render the renderer's real components with their
// real Mantine theme. It is NOT part of the electron-vite app build — see preview.tsx for the
// provider/CSS/font setup that mirrors src/renderer/src/main.tsx.
const config: StorybookConfig = {
  stories: ['../src/renderer/src/**/*.stories.@(ts|tsx)'],
  addons: [],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  core: {
    disableTelemetry: true,
  },
  // Mirror the renderer's Vite resolution so stories import components exactly as the app does:
  // the `@` alias, the shared-types source aliases, and camelCase-only CSS-module locals (the base
  // buttons use `styles.IconButtonOutline`-style camelCase keys).
  viteFinal: (cfg) =>
    mergeConfig(cfg, {
      resolve: {
        alias: {
          '@': resolve(process.cwd(), 'src/renderer/src'),
          ...sharedTypesSourceAliases(process.cwd()),
        },
      },
      css: {
        modules: {
          localsConvention: 'camelCaseOnly',
        },
      },
    }),
};

export default config;
