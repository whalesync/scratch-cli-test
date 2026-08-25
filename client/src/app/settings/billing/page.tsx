'use client';

import { ConfigSection } from '@/app/components/ConfigSection';
import { FullPageLoader } from '@/app/components/FullPageLoader';
import MainContent from '@/app/components/layouts/MainContent';
import { usePayments } from '@/hooks/use-payments';
import { useSelectedBillingInterval } from '@/hooks/use-selected-billing-interval';
import { Alert, Center, Divider, SimpleGrid, Stack } from '@mantine/core';
import { ScratchPlanType } from '@spinner/shared-types';
import { CreditCardIcon } from 'lucide-react';
import { useState } from 'react';
import { ActiveSubscriptionSection } from './components/ActiveSubscriptionSection';
import { BillingDevTools } from './components/BillingDevTools';
import { BillingIntervalToggle } from './components/BillingIntervalToggle';
import { PlanCard } from './components/PlanCard';
import { UsageSection } from './components/UsageSection';

/**
 * Width one plan card is allowed to grow to. The grid is capped at this times the number of cards and
 * centred, so a single plan renders as one readable card in the middle rather than being stretched
 * across the page or stranded in the left half of a fixed two-column grid.
 */
const PLAN_CARD_MAX_WIDTH_PX = 400;

export default function BillingSettingsPage() {
  const { plans, offeredBillingIntervals, isLoading, error } = usePayments();
  const [planError, setPlanError] = useState<string | null>(null);
  // Which prices the plan cards show. Lifted here so every card flips together.
  const { selectedBillingInterval, setSelectedBillingInterval } = useSelectedBillingInterval();

  // The Free plan isn't shown here — this section is only about plans you can move onto.
  const upgradeablePlans = plans?.filter((plan) => plan.planType === ScratchPlanType.PRO_PLAN) ?? [];

  if (isLoading) {
    return <FullPageLoader />;
  }

  return (
    <MainContent>
      <MainContent.BasicHeader title="Billing" Icon={CreditCardIcon} />
      <MainContent.Body>
        <Stack gap="20px" maw={800}>
          {error && <Alert color="red">{error}</Alert>}
          {planError && <Alert color="red">{planError}</Alert>}
          <UsageSection />
          <Divider c="var(--mantine-color-gray-3)" />
          <ActiveSubscriptionSection />
          <Divider c="var(--mantine-color-gray-3)" />
          <ConfigSection title="Plans" description="Upgrade or change your plan" hasBorder={false} p="0">
            <Stack gap="xs">
              <BillingIntervalToggle
                offeredBillingIntervals={offeredBillingIntervals}
                selectedBillingInterval={selectedBillingInterval}
                onChange={setSelectedBillingInterval}
              />
              <Center>
                <SimpleGrid
                  cols={Math.max(upgradeablePlans.length, 1)}
                  spacing="xs"
                  w="100%"
                  maw={Math.max(upgradeablePlans.length, 1) * PLAN_CARD_MAX_WIDTH_PX}
                >
                  {upgradeablePlans.map((plan) => (
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
          </ConfigSection>
          <BillingDevTools />
        </Stack>
      </MainContent.Body>
    </MainContent>
  );
}
