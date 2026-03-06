import axios from 'axios';
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

  axios.interceptors.request.use((config) => {
    if (!config.url) return config;
    for (const [originalOrigin, replacementOrigin] of overrides) {
      if (config.url.startsWith(originalOrigin + '/') || config.url === originalOrigin) {
        config.url = replacementOrigin + config.url.slice(originalOrigin.length);
        break;
      }
    }
    return config;
  });
}
