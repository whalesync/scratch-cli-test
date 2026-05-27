import { OAuthInitiateOptionsDto } from '@spinner/shared-types';
import { oAuthApi } from './oauth-api';

/**
 * Initiate OAuth flow for a service from the desktop app.
 * Opens the OAuth authorization URL in the system browser.
 * The callback will redirect back to the desktop app via a scratch:// deep link.
 */
export async function initiateDesktopOAuth(service: string, options: OAuthInitiateOptionsDto): Promise<void> {
  const response = await oAuthApi.initiate(service, options);
  // Open in the system browser (Electron will intercept scratch:// callback deep link)
  window.open(response.authUrl, '_blank');
}
