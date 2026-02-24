import { INTERNAL_SERVICES } from '@/types/server-entities/connector-accounts';
import { Service } from '@spinner/shared-types';
import { useCallback, useMemo } from 'react';
import { useScratchPadUser } from './useScratchpadUser';

export type AuthMethod = 'user_provided_params' | 'oauth' | 'oauth_custom';

/**
 * A utility hook for interacting with connectors and obtaingin connector specific config based on the current user.
 */
export const useConnectors = () => {
  const { user, isAdmin } = useScratchPadUser();

  const getDefaultAuthMethod = useCallback(
    (service: Service): AuthMethod => {
      // Services that support OAuth
      const oauthSupportedServices = [Service.NOTION, Service.YOUTUBE, Service.WIX_BLOG, Service.SUPABASE];

      if (service === Service.AIRTABLE && user?.experimentalFlags?.ENABLE_AIRTABLE_OAUTH) {
        oauthSupportedServices.push(Service.AIRTABLE);
      }
      if (service === Service.WEBFLOW && user?.experimentalFlags?.ENABLE_WEBFLOW_OAUTH) {
        oauthSupportedServices.push(Service.WEBFLOW);
      }
      if (service === Service.SHOPIFY && user?.experimentalFlags?.ENABLE_SHOPIFY_OAUTH) {
        oauthSupportedServices.push(Service.SHOPIFY);
      }

      // Services that use generic parameters
      const genericParametersSupportedServices = [
        Service.NOTION,
        Service.AIRTABLE,
        Service.WORDPRESS,
        Service.WEBFLOW,
        Service.SHOPIFY,
        Service.AUDIENCEFUL,
        Service.MOCO,
        Service.POSTGRES,
        Service.SUPABASE,
      ];
      if (oauthSupportedServices.includes(service)) {
        return 'oauth';
      } else if (genericParametersSupportedServices.includes(service)) {
        return 'user_provided_params';
      } else {
        return 'oauth'; // Default fallback
      }
    },
    [
      user?.experimentalFlags?.ENABLE_AIRTABLE_OAUTH,
      user?.experimentalFlags?.ENABLE_WEBFLOW_OAUTH,
      user?.experimentalFlags?.ENABLE_SHOPIFY_OAUTH,
    ],
  );

  const getSupportedAuthMethods = useCallback(
    (service: Service): AuthMethod[] => {
      const oauthSupportedServices = [Service.NOTION, Service.YOUTUBE, Service.WIX_BLOG, Service.SUPABASE];

      if (service === Service.AIRTABLE && user?.experimentalFlags?.ENABLE_AIRTABLE_OAUTH) {
        oauthSupportedServices.push(Service.AIRTABLE);
      }
      if (service === Service.WEBFLOW && user?.experimentalFlags?.ENABLE_WEBFLOW_OAUTH) {
        oauthSupportedServices.push(Service.WEBFLOW);
      }
      if (service === Service.SHOPIFY && user?.experimentalFlags?.ENABLE_SHOPIFY_OAUTH) {
        oauthSupportedServices.push(Service.SHOPIFY);
      }

      const userProvidedParamsSupportedServices = [
        Service.NOTION,
        Service.AIRTABLE,
        Service.WORDPRESS,
        Service.WEBFLOW,
        Service.SHOPIFY,
        Service.AUDIENCEFUL,
        Service.MOCO,
        Service.POSTGRES,
        Service.SUPABASE,
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
    [
      user?.experimentalFlags?.ENABLE_AIRTABLE_OAUTH,
      user?.experimentalFlags?.ENABLE_WEBFLOW_OAUTH,
      user?.experimentalFlags?.ENABLE_SHOPIFY_OAUTH,
    ],
  );

  // For admins show all services. Dedupe in case of overlap between flags and internal services.
  // In development, show all connectors without filtering.
  const availableServices = useMemo(() => {
    if (process.env.NODE_ENV === 'development') {
      return Object.values(Service);
    }
    const connectorListFromFlags = (user?.experimentalFlags?.CONNECTOR_LIST ?? []) as Service[];
    return isAdmin ? [...new Set([...connectorListFromFlags, ...INTERNAL_SERVICES])] : connectorListFromFlags;
  }, [user?.experimentalFlags?.CONNECTOR_LIST, isAdmin]);

  return {
    getDefaultAuthMethod,
    getSupportedAuthMethods,
    availableServices,
  };
};
