'use client';

import { AuthLayout } from '@/app/components/layouts/AuthLayout';
import { RouteUrls } from '@/utils/route-urls';
import { useAuth } from '@clerk/nextjs';
import { Loader, Stack, Text } from '@mantine/core';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useSWRConfig } from 'swr';

export default function SignOutPage() {
  const { signOut, isLoaded, isSignedIn } = useAuth();
  const { mutate } = useSWRConfig();
  const router = useRouter();

  useEffect(() => {
    if (!isLoaded) return;

    // Already signed out — Clerk's signOut() would resolve without navigating,
    // leaving the user stuck here. Redirect manually instead.
    if (!isSignedIn) {
      router.replace(RouteUrls.signInPageUrl);
      return;
    }

    // Clear SWR cache first so background revalidations (e.g. the 5-minute
    // refreshInterval on useScratchpadUser) don't fire authed requests after
    // Clerk clears the JWT and produce 401s before the previous page unmounts.
    mutate(() => true, undefined, { revalidate: false }).catch(console.error);

    // Let Clerk handle the post-signout navigation via `redirectUrl` so there is
    // only one navigation in flight. Doing our own router.replace afterward
    // races with Clerk's internal navigate('/') and aborts the RSC fetch.
    signOut({ redirectUrl: RouteUrls.signInPageUrl }).catch((err) => {
      console.error('Sign-out failed', err);
      router.replace(RouteUrls.signInPageUrl);
    });
  }, [isLoaded, isSignedIn, signOut, mutate, router]);

  return (
    <AuthLayout title="Signing out - Scratch">
      <Stack align="center" gap="md">
        <Loader />
        <Text c="dimmed">Signing out…</Text>
      </Stack>
    </AuthLayout>
  );
}
