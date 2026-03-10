import { AxiosInstance } from 'axios';
import { WSLogger } from 'src/logger';

// Parse overrides: each entry maps an origin (scheme+host+port) to a replacement origin.
// Example: API_URL_OVERRIDES=https://api.airtable.com=http://localhost:4646
const overrides: [string, string][] = (process.env.API_URL_OVERRIDES ?? '')
  .split(',')
  .filter(Boolean)
  .map((entry) => {
    // Split on "=" but skip the "=" inside "://"
    const eqIndex = entry.indexOf('=', entry.indexOf('://') + 3);
    return [entry.slice(0, eqIndex), entry.slice(eqIndex + 1)];
  });

if (overrides.length > 0) {
  WSLogger.info({
    source: 'api-url-overrides',
    message: `API URL overrides active: ${overrides.map(([from, to]) => `${from} -> ${to}`).join(', ')}`,
  });
}

/**
 * Apply URL override interceptors to an Axios instance.
 * Rewrites request URLs based on the API_URL_OVERRIDES environment variable.
 */
export function applyUrlOverrides(instance: AxiosInstance): void {
  if (overrides.length === 0) return;

  instance.interceptors.request.use((config) => {
    if (!config.url) return config;

    // For instances with a baseURL, the full URL isn't assembled yet at interceptor time.
    // Build the full URL to match against, then rewrite appropriately.
    const fullUrl = config.baseURL && !config.url.startsWith('http') ? config.baseURL + config.url : config.url;

    for (const [originalOrigin, replacementOrigin] of overrides) {
      if (fullUrl.startsWith(originalOrigin + '/') || fullUrl === originalOrigin) {
        // Replace the origin in the full URL
        const rewrittenUrl = replacementOrigin + fullUrl.slice(originalOrigin.length);

        if (config.baseURL && !config.url.startsWith('http')) {
          // Instance has a baseURL — clear it and use the full rewritten URL
          config.baseURL = '';
          config.url = rewrittenUrl;
        } else {
          config.url = rewrittenUrl;
        }
        break;
      }
    }
    return config;
  });
}
