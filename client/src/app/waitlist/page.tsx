'use client';

import { ButtonPrimarySolid } from '@/app/components/base/buttons';
import { Text13Regular, Text16Medium, TextTitle2 } from '@/app/components/base/text';
import { AuthLayout } from '@/app/components/layouts/AuthLayout';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { usersApi } from '@/lib/api/users';
import { RouteUrls } from '@/utils/route-urls';
import { Stack } from '@mantine/core';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { DotSpacer } from '../components/DotSpacer';

export default function WaitlistPage() {
  const { user, signOut } = useScratchPadUser();
  const router = useRouter();
  const [requested, setRequested] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleRequestAccess = useCallback(async () => {
    setLoading(true);
    try {
      await usersApi.requestAccess();
      setRequested(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user?.waitlistApproved) {
      router.push(RouteUrls.homePageUrl);
    }
  }, [user?.waitlistApproved, router]);

  if (user?.waitlistApproved) {
    return null;
  }

  return (
    <AuthLayout title="Waitlist - Scratch">
      <Stack align="center" gap="lg" maw={480} px="md">
        {requested ? (
          <>
            <TextTitle2 ta="center">You&apos;re on the list!</TextTitle2>
            <Text13Regular c="var(--fg-muted)" ta="center">
              We&apos;ll notify you when your account is approved.
            </Text13Regular>
          </>
        ) : (
          <>
            <Text16Medium c="var(--fg-secondary)" ta="center">
              We&apos;re gradually opening up access to Scratch.
              <br />
              Request access below and we&apos;ll get you in as soon as possible.
            </Text16Medium>

            <ButtonPrimarySolid onClick={handleRequestAccess} loading={loading}>
              Request Access
            </ButtonPrimarySolid>
          </>
        )}
        {/* <Group gap={0} align="baseline"> */}
        <Text13Regular c="dimmed" fz="12px">
          {user?.email}
          <DotSpacer />
          <Link href="#" onClick={signOut}>
            Sign out
          </Link>
        </Text13Regular>
        {/* </Group> */}
      </Stack>
    </AuthLayout>
  );
}
