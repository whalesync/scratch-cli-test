import { createScratchApiClient } from '@spinner/shared-types/api-client';

/**
 * The shared Scratch REST client for the web app. One long-lived instance; resource access is
 * namespaced (`scratchApiClient.users.activeUser()`).
 *
 * Auth: the client closes over a mutable Clerk token-provider rather than a token value, so a
 * sign-in / sign-out / user switch is picked up on the next request with no need to rebuild the
 * client. The provider is registered by the Clerk auth context — see
 * `client/src/contexts/auth.tsx`.
 */
let clerkTokenProvider: (() => Promise<string | null>) | null = null;

export function setScratchApiClientTokenProvider(provider: (() => Promise<string | null>) | null): void {
  clerkTokenProvider = provider;
}

export const scratchApiClient = createScratchApiClient({
  baseUrl: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3010',
  auth: {
    scheme: 'Bearer',
    getToken: () => (clerkTokenProvider ? clerkTokenProvider() : null),
  },
});
