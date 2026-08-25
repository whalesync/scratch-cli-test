import { Text13Book, Text16Medium } from '@/app/components/base/text';
import { Group, Stack } from '@mantine/core';
import { getMonthlyEquivalentCostUSD, SubscriptionPlanPrice } from '@spinner/shared-types';

/** Whole dollars stay whole ("$20"); anything else keeps cents ("$16.50"). */
function formatCostUSD(costUSD: number): string {
  return Number.isInteger(costUSD) ? `${costUSD}` : costUSD.toFixed(2);
}

/**
 * A plan's headline price. The interval is always rendered next to the amount, so a card is never
 * ambiguous about what "$192" buys, and an annual price also shows what it works out to per month.
 */
export const PlanPriceLabel = ({ price }: { price: SubscriptionPlanPrice | undefined }) => {
  // No price at any interval means the plan isn't sold — which, among the plans the UI renders, means
  // the Free plan. "Free" is both accurate and better copy than "$0 /month".
  if (!price) {
    return <Text16Medium>Free</Text16Medium>;
  }

  return (
    <Stack gap="2px">
      <Group gap="2px" align="baseline">
        <Text16Medium>${formatCostUSD(price.costUSD)}</Text16Medium>
        <Text13Book c="dimmed">/{price.billingInterval}</Text13Book>
      </Group>
      {price.billingInterval === 'year' && (
        <Text13Book c="dimmed">${formatCostUSD(getMonthlyEquivalentCostUSD(price))}/month, billed annually</Text13Book>
      )}
    </Stack>
  );
};
