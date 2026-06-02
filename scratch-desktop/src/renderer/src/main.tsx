import { StrictMode } from 'react';
import ReactDOM from 'react-dom/client';

// Mantine styles
import '@mantine/core/styles.css';
import '@mantine/notifications/styles.css';

// Fonts (replacing next/font/google)
// import '@fontsource-variable/funnel-display';
import '@fontsource/geist-mono/400.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';

// Global styles
import './theme/globals.css';

import App from './App';
import { logPerf } from './lib/perf';

const renderStart = performance.now();
const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found');
}
ReactDOM.createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
logPerf('renderer reactRoot render', performance.now() - renderStart);
