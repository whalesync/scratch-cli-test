import { useSubscription } from '@/hooks/use-subscription';
import { BillingInterval } from '@spinner/shared-types';
import { useState } from 'react';

export interface UseSelectedBillingIntervalReturn {
  selectedBillingInterval: BillingInterval;
  setSelectedBillingInterval: (billingInterval: BillingInterval) => void;
}

/**
 * Which prices the plan grid shows, for the pages that render a Monthly/Yearly toggle.
 *
 * Defaults to the interval the organization is already billed at, so an annual subscriber doesn't
 * land on the Monthly tab where their own plan reads "$20/month · Switch" and nothing on the page is
 * marked "Current Plan". The current interval is used as a *fallback* rather than seeded into
 * `useState`, because the subscription arrives with the user record and can land after the first
 * render; once the user picks an interval their choice wins and is never overwritten.
 */
export function useSelectedBillingInterval(): UseSelectedBillingIntervalReturn {
  const { subscription } = useSubscription();
  const [manuallySelectedBillingInterval, setManuallySelectedBillingInterval] = useState<BillingInterval | null>(null);

  return {
    selectedBillingInterval: manuallySelectedBillingInterval ?? subscription.billingInterval,
    setSelectedBillingInterval: setManuallySelectedBillingInterval,
  };
}
