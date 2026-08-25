import { ButtonPrimaryLight } from '@/components/base/buttons';
import { Text13Book, Text13Medium, Text13Regular } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import customBordersClasses from '@/components/theme/custom-borders.module.css';
import { usePayments } from '@/hooks/use-payments';
import { useSubscription } from '@/hooks/use-subscription';
import { Badge, Box, Group, Stack, Tooltip } from '@mantine/core';
import {
  BillingInterval,
  findPurchasablePriceForBillingInterval,
  ScratchPlanType,
  SubscriptionPlan,
} from '@spinner/shared-types';
import { Check } from 'lucide-react';
import { useCallback, useEffect } from 'react';
import { PlanPriceLabel } from './PlanPriceLabel';

interface PlanCardProps {
  plan: SubscriptionPlan;
  selectedBillingInterval: BillingInterval;
  onError: (error: string | null) => void;
}

/**
 * A single plan tile with its Subscribe / Upgrade / Switch / Downgrade / Current Plan action. Desktop counterpart
 * of the web client's billing `PlanCard`. Differs from web only in that there is no signed-out state (the desktop
 * is always authenticated) and the Stripe redirects open the system browser via `usePayments`.
 */
export const PlanCard = ({ plan, selectedBillingInterval, onError }: PlanCardProps) => {
  const { subscription, isFreePlan } = useSubscription();
  const {
    redirectToUpdateSubscription,
    redirectToCancelSubscription,
    portalRedirectInProgress,
    redirectToPlanCheckout,
    portalRedirectError,
  } = usePayments();
  // The price this card offers. Falls back to the plan's only price when it isn't sold at the
  // selected interval (e.g. a monthly-only plan while "Yearly" is selected) — the label always
  // carries the interval, so showing the monthly price there is accurate rather than misleading.
  const priceOnOffer =
    findPurchasablePriceForBillingInterval(plan, selectedBillingInterval) ?? plan.purchasablePrices[0];

  // "Current plan" means this exact price, not just this plan tier — otherwise a monthly Pro subscriber
  // looking at the Yearly tab would see their own plan greyed out with no way to switch to it. A plan
  // that isn't sold at any interval (the Free plan) has no price to match on, so plan type alone
  // decides — without that, a Free-plan user's own card would offer them a "Downgrade" to it.
  const isCurrentPlan =
    subscription.planType === plan.planType &&
    (priceOnOffer === undefined || subscription.billingInterval === priceOnOffer.billingInterval);

  useEffect(() => {
    onError(portalRedirectError);
  }, [portalRedirectError, onError]);

  const handleDowngrade = useCallback(() => {
    void redirectToCancelSubscription();
  }, [redirectToCancelSubscription]);

  const handleCheckout = useCallback(() => {
    if (!priceOnOffer) {
      return;
    }
    if (isFreePlan) {
      // No active subscription yet → start a fresh checkout.
      void redirectToPlanCheckout(plan.planType, priceOnOffer.billingInterval);
    } else {
      // Already subscribed → switch through the customer portal.
      void redirectToUpdateSubscription(plan.planType, priceOnOffer.billingInterval);
    }
  }, [plan.planType, priceOnOffer, redirectToUpdateSubscription, redirectToPlanCheckout, isFreePlan]);

  let actionButton = null;
  if (!subscription.canManageSubscription) {
    actionButton = <></>;
  } else if (isCurrentPlan) {
    actionButton = <ButtonPrimaryLight disabled={true}>Current Plan</ButtonPrimaryLight>;
  } else if (plan.planType !== ScratchPlanType.FREE_PLAN) {
    actionButton = (
      // Always "Switch": with per-interval pricing an "Upgrade"/"Switch" split on cost would compare a
      // yearly total against a monthly one, which says nothing useful. "Switch" is true in every direction.
      <ButtonPrimaryLight onClick={handleCheckout} loading={portalRedirectInProgress} disabled={!priceOnOffer}>
        Switch
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
          {plan.popular && !isCurrentPlan && <Badge w="fit-content">Popular</Badge>}
        </Group>
        <PlanPriceLabel price={priceOnOffer} />
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
