import { useCurrentUser } from '@/hooks/use-current-user';
import { usePayments } from '@/hooks/use-payments';
import { Alert, Box, Center, Divider, Loader, ScrollArea, SimpleGrid, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ScratchPlanType } from '@spinner/shared-types';
import { CreditCardIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SettingsPageHeader, SettingsSection } from '../SettingsSection';
import { ActiveSubscriptionSection } from './ActiveSubscriptionSection';
import { PlanCard } from './PlanCard';
import { UsageSection } from './UsageSection';

// Reuse one id so a re-fire replaces the previous toast rather than stacking.
const BILLING_STATUS_NOTIFICATION_ID = 'billing-return-status';

/**
 * Billing sub-section of the desktop Settings view — full parity with the web client's `/settings/billing`:
 * usage at a glance, the active subscription with a Manage action, and the plan catalog with Subscribe/Upgrade.
 */
export function BillingSettingsPage() {
  const { plans, isLoading, error } = usePayments();
  const { refreshUser } = useCurrentUser();
  const [planError, setPlanError] = useState<string | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  // We land here both from the UserMenu and from a Stripe redirect (scratch://settings/billing). After a
  // checkout/portal change the subscription on the user may have just changed, so refresh it on mount.
  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  // The Stripe billing return flow redirects back into the app with a `status` (success | cancel), forwarded by
  // the web bounce page and the deep-link mapper. Surface a toast for the outcome, then strip the param so it
  // doesn't re-fire on a later re-render or a back-navigation onto this route.
  useEffect(() => {
    const status = searchParams.get('status');
    if (status !== 'success' && status !== 'cancel') {
      return;
    }

    notifications.hide(BILLING_STATUS_NOTIFICATION_ID);
    if (status === 'success') {
      notifications.show({
        id: BILLING_STATUS_NOTIFICATION_ID,
        title: 'Payment complete',
        message: 'Your subscription has been updated.',
        color: 'green',
        autoClose: 6000,
        withCloseButton: true,
      });
    } else {
      notifications.show({
        id: BILLING_STATUS_NOTIFICATION_ID,
        title: 'Checkout cancelled',
        message: 'No changes were made to your subscription.',
        color: 'yellow',
        autoClose: 6000,
        withCloseButton: true,
      });
    }

    setSearchParams(
      (previousParams) => {
        const nextParams = new URLSearchParams(previousParams);
        nextParams.delete('status');
        return nextParams;
      },
      { replace: true },
    );
  }, [searchParams, setSearchParams]);

  return (
    <Stack h="100%" gap={0}>
      <SettingsPageHeader Icon={CreditCardIcon} title="Billing" />
      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        {isLoading ? (
          <Center h={240}>
            <Loader size="sm" />
          </Center>
        ) : (
          <Box p="md">
            <Stack gap="20px" maw={800}>
              {error && <Alert color="red">{error}</Alert>}
              {planError && <Alert color="red">{planError}</Alert>}
              <UsageSection />
              <Divider />
              <ActiveSubscriptionSection />
              <Divider />
              <SettingsSection title="Plans" description="Upgrade or change your plan" hasBorder={false}>
                <SimpleGrid cols={2} spacing="xs">
                  {plans
                    .filter(
                      (plan) =>
                        plan.planType === ScratchPlanType.PRO_PLAN || plan.planType === ScratchPlanType.MAX_PLAN,
                    )
                    .map((plan) => (
                      <PlanCard key={plan.planType} plan={plan} onError={setPlanError} />
                    ))}
                </SimpleGrid>
              </SettingsSection>
            </Stack>
          </Box>
        )}
      </ScrollArea>
    </Stack>
  );
}
