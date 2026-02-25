// app/providers.tsx
'use client';

import { JSX, ReactNode, useEffect } from 'react';

import posthog from 'posthog-js';
import { PostHogProvider } from '@posthog/react';

interface PosthogProviderProps {
  children: ReactNode;
}

/**
 * An fake PostHogProvider that does nothing but consume the same paramters as the normal PostHogProvider and render
 * children. This exists so that Dusky goesn't generate console errors because an empty component does not
 * consume the 'client' prop.
 */
export const EmptyPosthogProvider = ({ children }: PosthogProviderProps): JSX.Element => {
  return <>{children}</>;
};

export function ScratchpadPostHogProvider({ children }: PosthogProviderProps): JSX.Element {
  useEffect(() => {
    if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) {
      console.warn('NEXT_PUBLIC_POSTHOG_KEY is not set, skipping PostHog initialization');
      return;
    }

    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY as string, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
      person_profiles: 'identified_only', // or 'always' to create profiles for anonymous users as well
      defaults: '2025-05-24',
    });
  }, []);

  if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
    return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
  }

  return <EmptyPosthogProvider>{children}</EmptyPosthogProvider>;
}
