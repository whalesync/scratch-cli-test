'use client';

import { RouteUrls } from '@/utils/route-urls';
import { useAuth, useUser } from '@clerk/nextjs';
import { Alert, Box, Center, Divider, Group, SimpleGrid, Stack } from '@mantine/core';
import { useState } from 'react';
import { usePayments } from '../../hooks/use-payments';
import { useSelectedBillingInterval } from '../../hooks/use-selected-billing-interval';
import { useSubscription } from '../../hooks/use-subscription';
import { ButtonPrimarySolid, ButtonSecondaryOutline } from '../components/base/buttons';
import { Text13Book, Text13Regular, Text16Regular, TextTitle1 } from '../components/base/text';
import { FullPageLoader } from '../components/FullPageLoader';
import { BillingIntervalToggle } from '../settings/billing/components/BillingIntervalToggle';
import { PlanCard } from '../settings/billing/components/PlanCard';

export default function PricingPage() {
  const { plans, offeredBillingIntervals, isLoading, error, redirectToManageSubscription, portalRedirectInProgress } =
    usePayments();
  const { isSignedIn, signOut } = useAuth();
  const { user: clerkUser } = useUser();
  const { subscription, isFreePlan } = useSubscription();
  const [planError, setPlanError] = useState<string | null>(null);
  // Which prices the plan cards show. Lifted here so every card flips together.
  const { selectedBillingInterval, setSelectedBillingInterval } = useSelectedBillingInterval();

  if (isLoading) {
    return <FullPageLoader />;
  }

  return (
    <Box
      style={{
        minHeight: '100vh',
        backgroundColor: 'var(--bg-base)',
      }}
    >
      <Stack gap="xl" align="center" py="xl" px="md">
        {/* Hero section */}
        <Stack align="center" gap="md" maw={600} style={{ textAlign: 'center' }}>
          <Box
            style={{
              width: 80,
              height: 80,
              backgroundColor: '#9BF9EB',
              borderRadius: 16,
              backgroundImage: 'url(/logo-color.svg)',
              backgroundSize: 90,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'center',
            }}
          />
          <TextTitle1>Scratch</TextTitle1>
          <Text16Regular c="var(--fg-secondary)">
            Edit your content as files. Put it back without breaking anything.
          </Text16Regular>
        </Stack>

        {error && <Alert color="red">{error}</Alert>}
        {planError && <Alert color="red">{planError}</Alert>}

        {/* Plan cards */}
        <Stack gap="xs" w="100%" maw={900}>
          <BillingIntervalToggle
            offeredBillingIntervals={offeredBillingIntervals}
            selectedBillingInterval={selectedBillingInterval}
            onChange={setSelectedBillingInterval}
          />
          <Center>
            {/* Column count follows the plans actually on offer, capped at 3, so retiring a plan
                doesn't leave a hole in the grid. */}
            <SimpleGrid cols={Math.min(Math.max(plans?.length ?? 1, 1), 3)} spacing="xs" maw={900}>
              {plans?.map((plan) => (
                <PlanCard
                  key={plan.planType}
                  plan={plan}
                  selectedBillingInterval={selectedBillingInterval}
                  onError={setPlanError}
                />
              ))}
            </SimpleGrid>
          </Center>
        </Stack>

        <Divider w="100%" maw={900} c="var(--mantine-color-gray-3)" />

        {/* Bottom CTA */}
        {isSignedIn ? (
          <Stack align="center" gap="sm">
            <Group gap="xs" align="baseline">
              <Text13Regular>
                Signed in as {clerkUser?.primaryEmailAddress?.emailAddress} &middot;{' '}
                <a href="#" onClick={() => signOut()} style={{ color: 'var(--fg-secondary)' }}>
                  Sign out
                </a>
              </Text13Regular>
            </Group>
            <Text13Book c="dimmed">
              {subscription.planDisplayName} plan &middot; ${subscription.costUSD}/{subscription.billingInterval}
            </Text13Book>
            {!isFreePlan && subscription.canManageSubscription && (
              <ButtonSecondaryOutline
                onClick={() => redirectToManageSubscription(RouteUrls.pricingPageUrl)}
                loading={portalRedirectInProgress}
              >
                Manage subscription
              </ButtonSecondaryOutline>
            )}
          </Stack>
        ) : (
          <Stack align="center" gap="sm">
            <Text16Regular c="var(--fg-secondary)">Ready to get started?</Text16Regular>
            <Group gap="sm">
              <ButtonPrimarySolid component="a" href={RouteUrls.signUpPageUrl}>
                Create an account
              </ButtonPrimarySolid>
              <ButtonSecondaryOutline component="a" href={RouteUrls.signInPageUrl}>
                Sign in
              </ButtonSecondaryOutline>
            </Group>
          </Stack>
        )}
      </Stack>
    </Box>
  );
}
