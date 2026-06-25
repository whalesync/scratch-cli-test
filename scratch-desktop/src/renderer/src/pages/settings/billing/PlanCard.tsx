import { ButtonPrimaryLight } from '@/components/base/buttons';
import { Text13Book, Text13Medium, Text13Regular, Text16Medium } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import customBordersClasses from '@/components/theme/custom-borders.module.css';
import { usePayments } from '@/hooks/use-payments';
import { useSubscription } from '@/hooks/use-subscription';
import { Badge, Box, Center, Group, Stack, Tooltip } from '@mantine/core';
import { ScratchPlanType, SubscriptionPlan } from '@spinner/shared-types';
import { Check } from 'lucide-react';
import { useCallback, useEffect } from 'react';

interface PlanCardProps {
  plan: SubscriptionPlan;
  onError: (error: string | null) => void;
}

/**
 * A single plan tile with its Subscribe / Upgrade / Switch / Downgrade / Current Plan action. Desktop counterpart
 * of the web client's billing `PlanCard`. Differs from web only in that there is no signed-out state (the desktop
 * is always authenticated) and the Stripe redirects open the system browser via `usePayments`.
 */
export const PlanCard = ({ plan, onError }: PlanCardProps) => {
  const { subscription, isFreePlan } = useSubscription();
  const {
    redirectToUpdateSubscription,
    redirectToCancelSubscription,
    portalRedirectInProgress,
    redirectToPlanCheckout,
    portalRedirectError,
  } = usePayments();
  const isCurrentPlan = subscription.planType === plan.planType;
  const isComingSoon = plan.planType === ScratchPlanType.MAX_PLAN;

  useEffect(() => {
    onError(portalRedirectError);
  }, [portalRedirectError, onError]);

  const handleDowngrade = useCallback(() => {
    void redirectToCancelSubscription();
  }, [redirectToCancelSubscription]);

  const handleCheckout = useCallback(() => {
    if (isFreePlan) {
      // No active subscription yet → start a fresh checkout.
      void redirectToPlanCheckout(plan.planType);
    } else {
      // Already subscribed → switch/upgrade through the customer portal.
      void redirectToUpdateSubscription(plan.planType);
    }
  }, [plan.planType, redirectToUpdateSubscription, redirectToPlanCheckout, isFreePlan]);

  let actionButton = null;
  if (!subscription.canManageSubscription) {
    actionButton = <></>;
  } else if (isComingSoon) {
    actionButton = (
      <Center w="100%" h="36px" bg="var(--bg-panel)" className={customBordersClasses.cornerBorders}>
        <Text13Regular c="dimmed">Coming soon</Text13Regular>
      </Center>
    );
  } else if (isCurrentPlan) {
    actionButton = <ButtonPrimaryLight disabled={true}>Current Plan</ButtonPrimaryLight>;
  } else if (plan.planType !== ScratchPlanType.FREE_PLAN) {
    actionButton = (
      <ButtonPrimaryLight onClick={handleCheckout} loading={portalRedirectInProgress}>
        {subscription.costUSD > plan.costUSD ? 'Switch' : 'Upgrade'}
      </ButtonPrimaryLight>
    );
  } else if (subscription.isCancelled) {
    actionButton = (
      <Tooltip
        label={`You have already cancelled your subscription, your account will switch to the ${plan.displayName} plan on the next billing cycle.`}
        multiline
        w={300}
      >
        <ButtonPrimaryLight onClick={handleDowngrade} disabled={true}>
          Downgrade
        </ButtonPrimaryLight>
      </Tooltip>
    );
  } else {
    actionButton = (
      <ButtonPrimaryLight onClick={handleDowngrade} loading={portalRedirectInProgress}>
        Downgrade
      </ButtonPrimaryLight>
    );
  }

  const currentPlanStyle = isCurrentPlan ? { backgroundColor: 'var(--mantine-primary-color-light)' } : {};

  return (
    <Box
      px={12}
      py={10}
      className={customBordersClasses.cornerBorders}
      style={{ position: 'relative', ...currentPlanStyle }}
    >
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <Text13Medium>{plan.displayName}</Text13Medium>
          {isComingSoon && <Badge w="fit-content">Coming soon</Badge>}
          {plan.popular && !isCurrentPlan && !isComingSoon && <Badge w="fit-content">Popular</Badge>}
        </Group>
        <Group gap="2px">
          <Text16Medium>${plan.costUSD}</Text16Medium>
          <Text13Book c="dimmed">/month</Text13Book>
        </Group>
        {actionButton}

        <Stack gap="xs" mt="xs">
          <Text13Book c="dimmed">Features:</Text13Book>
          <FeatureLineItem
            id="publishingLimit"
            label={
              plan.features.publishingLimit > 0
                ? `${plan.features.publishingLimit} publishing actions`
                : 'Unlimited publishing'
            }
          />
          {plan.features.dataSourcePerServiceLimit === 0 ? (
            <FeatureLineItem id="dataSourcePerServiceLimit" label="Multiple accounts per external service" />
          ) : (
            <FeatureLineItem id="dataSourcePerServiceLimit" label="Single account per external service" />
          )}
        </Stack>
      </Stack>
    </Box>
  );
};

const FeatureLineItem = ({ id, label }: { id: string; label: string }) => {
  return (
    <Group id={id} gap="xs" align="flex-start" justify="flex-start" wrap="nowrap">
      <StyledLucideIcon Icon={Check} size={16} c="gray" />
      <Text13Regular>{label}</Text13Regular>
    </Group>
  );
};
