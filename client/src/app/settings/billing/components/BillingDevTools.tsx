import { DevToolButton } from '@/app/components/base/buttons';
import { Text13Regular } from '@/app/components/base/text';
import { ConfigSection } from '@/app/components/ConfigSection';
import { useDevTools } from '@/hooks/use-dev-tools';
import { useSubscription } from '@/hooks/use-subscription';
import { useUserDevTools } from '@/hooks/use-user-dev-tools';
import { isLocalBuild, isTestBuild } from '@/utils/build';
import { SimpleGrid, Stack } from '@mantine/core';
import { ScratchPlanType } from '@spinner/shared-types';

export const BillingDevTools = () => {
  const { isDevToolsEnabled } = useDevTools();
  const { subscription } = useSubscription();
  const {
    updateActiveUserSubscription,
    forceExpireActiveUserSubscription,
    forceCancelActiveUserSubscription,
    deleteActiveUserSubscriptions,
    isLoading,
  } = useUserDevTools();

  if (!isDevToolsEnabled || (!isLocalBuild() && !isTestBuild())) {
    return null;
  }

  return (
    <ConfigSection title="Dev Tools" description="Testing tools for subscriptions">
      <Stack gap="xs">
        <SimpleGrid cols={3}>
          <DevToolButton
            onClick={() => updateActiveUserSubscription(ScratchPlanType.FREE_PLAN)}
            loading={isLoading}
            disabled={subscription.planType === ScratchPlanType.FREE_PLAN}
            leftSection={null}
          >
            Switch to Free Plan
          </DevToolButton>
          <DevToolButton
            onClick={() => updateActiveUserSubscription(ScratchPlanType.PRO_PLAN)}
            loading={isLoading}
            disabled={subscription.planType === ScratchPlanType.PRO_PLAN}
            leftSection={null}
          >
            Switch to Pro Plan
          </DevToolButton>
          <DevToolButton
            onClick={() => forceExpireActiveUserSubscription()}
            loading={isLoading}
            disabled={subscription.planType === ScratchPlanType.FREE_PLAN}
            leftSection={null}
          >
            Expire Current Subscription
          </DevToolButton>
          <DevToolButton
            onClick={() => forceCancelActiveUserSubscription()}
            loading={isLoading}
            disabled={subscription.planType === ScratchPlanType.FREE_PLAN}
            leftSection={null}
          >
            Cancel Subscription (in 14 days)
          </DevToolButton>
          <DevToolButton onClick={() => deleteActiveUserSubscriptions()} loading={isLoading} leftSection={null}>
            Delete Subscriptions
          </DevToolButton>
        </SimpleGrid>
        <Text13Regular c="dimmed">
          Only use these tools in the development environment. They will hack your Subscription records in the local
          database and modify your Scratch Open Router API key but not interact with Stripe.
        </Text13Regular>
        <Text13Regular c="dimmed">
          NOTE: there is a slight delay with OpernRouter API key updates. The Credit Usage limit may take a few seconds
          to update properly, which will require some a few refreshes to see the correct usage.
        </Text13Regular>
      </Stack>
    </ConfigSection>
  );
};
