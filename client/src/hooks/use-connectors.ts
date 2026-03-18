import { Service } from '@spinner/shared-types';
import { useCallback, useMemo } from 'react';
import { hasOAuth, useConnectorsMetadata } from './use-connectors-metadata';

export type AuthMethod = 'user_provided_params' | 'oauth' | 'oauth_custom';

/**
 * A utility hook for interacting with connectors and obtaingin connector specific config based on the current user.
 */
export const useConnectors = () => {
  const { metadata } = useConnectorsMetadata();

  const webflowOAuthEnabled = hasOAuth(metadata, Service.WEBFLOW);

  const getDefaultAuthMethod = useCallback(
    (service: Service): AuthMethod => {
      // Services that support OAuth
      const oauthSupportedServices: string[] = [
        Service.NOTION,
        Service.YOUTUBE,
        Service.WIX_BLOG,
        Service.SUPABASE,
        Service.AIRTABLE,
        Service.SHOPIFY,
      ];

      if (service === Service.WEBFLOW && webflowOAuthEnabled) {
        oauthSupportedServices.push(Service.WEBFLOW);
      }

      // Services that use generic parameters
      const genericParametersSupportedServices: string[] = [
        Service.NOTION,
        Service.AIRTABLE,
        Service.WORDPRESS,
        Service.WEBFLOW,
        Service.SHOPIFY,
        Service.AUDIENCEFUL,
        Service.MOCO,
        Service.POSTGRES,
        Service.SUPABASE,
        Service.PIPEDRIVE,
      ];
      if (oauthSupportedServices.includes(service)) {
        return 'oauth';
      } else if (genericParametersSupportedServices.includes(service)) {
        return 'user_provided_params';
      } else {
        return 'oauth'; // Default fallback
      }
    },
    [webflowOAuthEnabled],
  );

  const getSupportedAuthMethods = useCallback(
    (service: Service): AuthMethod[] => {
      const oauthSupportedServices: string[] = [
        Service.NOTION,
        Service.YOUTUBE,
        Service.WIX_BLOG,
        Service.SUPABASE,
        Service.AIRTABLE,
        Service.SHOPIFY,
      ];

      if (service === Service.WEBFLOW && webflowOAuthEnabled) {
        oauthSupportedServices.push(Service.WEBFLOW);
      }

      const userProvidedParamsSupportedServices: string[] = [
        Service.NOTION,
        Service.AIRTABLE,
        Service.WORDPRESS,
        Service.WEBFLOW,
        Service.SHOPIFY,
        Service.AUDIENCEFUL,
        Service.MOCO,
        Service.POSTGRES,
        Service.SUPABASE,
        Service.PIPEDRIVE,
      ];
      const methods: AuthMethod[] = [];
      if (oauthSupportedServices.includes(service)) {
        methods.push('oauth');
        // Enable Private OAuth only for YouTube (generic-ready for future services)
        if (service === Service.YOUTUBE) {
          methods.push('oauth_custom');
        }
      }
      if (userProvidedParamsSupportedServices.includes(service)) {
        methods.push('user_provided_params');
      }
      return methods;
    },
    [webflowOAuthEnabled],
  );

  // Show all connectors with visible=true. In development, show all connectors.
  const availableServices = useMemo(() => {
    if (process.env.NODE_ENV === 'development') {
      return Object.values(Service);
    }
    if (!metadata) return [];
    return Object.entries(metadata)
      .filter(([, m]) => m.visible)
      .map(([s]) => s) as Service[];
  }, [metadata]);

  return {
    getDefaultAuthMethod,
    getSupportedAuthMethods,
    availableServices,
  };
};
