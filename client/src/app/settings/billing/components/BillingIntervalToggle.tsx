import { Group, SegmentedControl } from '@mantine/core';
import { BillingInterval, isBillingInterval } from '@spinner/shared-types';

const BILLING_INTERVAL_LABELS: Record<BillingInterval, string> = {
  month: 'Monthly',
  year: 'Yearly',
};

interface BillingIntervalToggleProps {
  /** Intervals to offer, derived from the plans actually on sale (`getOfferedBillingIntervals`). */
  offeredBillingIntervals: BillingInterval[];
  selectedBillingInterval: BillingInterval;
  onChange: (billingInterval: BillingInterval) => void;
}

/**
 * Monthly/Yearly switch above the plan grid. Renders nothing unless there is a genuine choice to
 * make: an environment whose Stripe account only has monthly prices shows no toggle rather than one
 * that leads to empty cards.
 */
export const BillingIntervalToggle = ({
  offeredBillingIntervals,
  selectedBillingInterval,
  onChange,
}: BillingIntervalToggleProps) => {
  if (offeredBillingIntervals.length < 2) {
    return null;
  }

  return (
    // Centred so it reads as a control belonging to the plan cards below it, rather than drifting to
    // the opposite corner of the page when only one plan is on offer.
    <Group justify="center">
      <SegmentedControl
        size="xs"
        value={selectedBillingInterval}
        onChange={(value) => {
          if (isBillingInterval(value)) {
            onChange(value);
          }
        }}
        data={offeredBillingIntervals.map((billingInterval) => ({
          value: billingInterval,
          label: BILLING_INTERVAL_LABELS[billingInterval],
        }))}
      />
    </Group>
  );
};
