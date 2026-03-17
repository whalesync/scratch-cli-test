import { oAuthApi } from '@/lib/api/oauth';
import { OAuthInitiateOptionsDto, Service } from '@spinner/shared-types';

/**
 * Initiate OAuth flow for a service.
 *
 * This function will redirect the user to the OAuth provider's authorization flow.
 */
export const initiateOAuth = async (service: Service, options: OAuthInitiateOptionsDto): Promise<void> => {
  try {
    // Get the OAuth URL from the server (service is now included in state parameter)
    const response = await oAuthApi.initiate(service, options);

    // Redirect the user to the OAuth provider
    window.location.href = response.authUrl;
  } catch (error) {
    console.error(`Failed to initiate OAuth for ${service}:`, error);
    throw error;
  }
};
