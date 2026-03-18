import { ScratchPlanType, SubscriptionPlan, SubscriptionPlanFeatures } from '@spinner/shared-types';
import { Plan, PlanFeatures } from '../plans';

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
  costUSD: number;
  features: SubscriptionPlanFeatures;

  constructor(plan: Plan) {
    this.planType = plan.planType;
    this.displayName = plan.displayName;
    this.popular = plan.popular;
    this.costUSD = plan.costUSD;
    this.features = new SubscriptionPlanFeaturesEntity(plan.features);
  }
}
