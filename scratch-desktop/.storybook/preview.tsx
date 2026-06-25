// `import React` is required: this file lives outside src/ (so outside tsconfig.web.json's
// `jsx: react-jsx`), so esbuild compiles the decorator's JSX with the classic runtime — which
// references `React` directly. Without this import the decorator throws "React is not defined"
// and no story ever renders.
import type { Preview } from '@storybook/react-vite';
import React from 'react';
import { AppMantineProvider } from '../src/renderer/src/providers/MantineProvider';

// Mirror src/renderer/src/main.tsx so stories render byte-identically to the app.
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';

// Fonts. NOTE: the running app currently leaves Funnel Display (the heading font) commented out
// in main.tsx, so its headings fall back to Inter. The theme (theme.ts) intends Funnel Display for
// headings, so we load it here to render the design system as designed. The app's main.tsx should
// be fixed to match — tracked separately.
import '@fontsource-variable/funnel-display';
import '@fontsource/geist-mono/400.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';

import '../src/renderer/src/theme/globals.css';

const preview: Preview = {
  parameters: {
    layout: 'padded',
    controls: { expanded: true },
  },
  // Every story renders inside the real provider (theme = SCRATCH_MANTINE_THEME, light scheme).
  decorators: [
    (Story) => (
      <AppMantineProvider>
        <Story />
      </AppMantineProvider>
    ),
  ],
};

export default preview;
