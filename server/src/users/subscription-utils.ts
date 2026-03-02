import { getPlan } from 'src/payment/plans';
import { SubscriptionStatus } from './types';

export function isSubscriptionActive(subscriptionStatus: SubscriptionStatus): boolean {
  return subscriptionStatus?.status === 'active';
}

export function canCreateDataSource(
  subscriptionStatus: SubscriptionStatus | undefined,
  existingDataSources: number,
): boolean {
  if (!subscriptionStatus || !isSubscriptionActive(subscriptionStatus)) {
    // START HACK: Allow in dev
    // if (process.env.NODE_ENV !== 'production') {
    //   return true;
    // }
    // END HACK
    return false;
  }

  const plan = getPlan(subscriptionStatus.planType);

  const limit = plan?.features.dataSourcePerServiceLimit ?? 1;

  if (limit === 0) {
    return true;
  }

  return existingDataSources < limit;
  // return existingDataSources < limit || process.env.NODE_ENV !== 'production';
}
