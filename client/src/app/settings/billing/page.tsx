'use client';

import { ConfigSection } from '@/app/components/ConfigSection';
import { FullPageLoader } from '@/app/components/FullPageLoader';
import MainContent from '@/app/components/layouts/MainContent';
import { usePayments } from '@/hooks/use-payments';
import { Alert, Divider, SimpleGrid, Stack } from '@mantine/core';
import { ScratchPlanType } from '@spinner/shared-types';
import { CreditCardIcon } from 'lucide-react';
import { useState } from 'react';
import { ActiveSubscriptionSection } from './components/ActiveSubscriptionSection';
import { BillingDevTools } from './components/BillingDevTools';
import { PlanCard } from './components/PlanCard';
import { UsageSection } from './components/UsageSection';

export default function BillingSettingsPage() {
  const { plans, isLoading, error } = usePayments();
  const [planError, setPlanError] = useState<string | null>(null);

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
            <SimpleGrid cols={2} spacing="xs">
              {plans
                ?.filter(
                  (plan) => plan.planType === ScratchPlanType.PRO_PLAN || plan.planType === ScratchPlanType.MAX_PLAN,
                )
                .map((plan) => (
                  <PlanCard key={plan.planType} plan={plan} onError={setPlanError} />
                ))}
            </SimpleGrid>
          </ConfigSection>
          <BillingDevTools />
        </Stack>
      </MainContent.Body>
    </MainContent>
  );
}
