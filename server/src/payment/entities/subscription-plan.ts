import {
  ScratchPlanType,
  SubscriptionPlan,
  SubscriptionPlanFeatures,
  SubscriptionPlanPrice,
} from '@spinner/shared-types';
import { getPlanPriceForBillingInterval, Plan, PlanFeatures } from '../plans';

export class SubscriptionPlanFeaturesEntity implements SubscriptionPlanFeatures {
  publishingLimit: number;
  dataSourcePerServiceLimit: number;

  constructor(features: PlanFeatures) {
    this.publishingLimit = features.publishingLimit;
    this.dataSourcePerServiceLimit = features.dataSourcePerServiceLimit;
  }
}

export class SubscriptionPlanEntity implements SubscriptionPlan {
  planType: ScratchPlanType;
  displayName: string;
  popular: boolean;
  purchasablePrices: SubscriptionPlanPrice[];
  /** @deprecated Monthly list price, kept only for pre-annual-billing desktop builds. See the shared type. */
  costUSD: number;
  features: SubscriptionPlanFeatures;

  constructor(plan: Plan) {
    this.planType = plan.planType;
    this.displayName = plan.displayName;
    this.popular = plan.popular;
    // Deliberately drops `stripePriceId`: the frontends pick a price by (plan, billingInterval) and
    // the server resolves the id, so a Stripe price id never needs to reach the browser.
    this.purchasablePrices = plan.purchasablePrices.map((price) => ({
      billingInterval: price.billingInterval,
      costUSD: price.costUSD,
    }));
    // Back-compat only: a desktop build older than annual billing renders `${plan.costUSD}/month` and
    // sorts the plan list on it, so dropping the field outright would show it "$undefined" until the
    // user takes the auto-update. The monthly price is exactly what those builds used to receive.
    this.costUSD = getPlanPriceForBillingInterval(plan, 'month')?.costUSD ?? 0;
    this.features = new SubscriptionPlanFeaturesEntity(plan.features);
  }
}
