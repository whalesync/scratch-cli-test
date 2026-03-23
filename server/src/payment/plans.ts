import { ScratchPlanType } from '@spinner/shared-types';
import { ScratchConfigService, ScratchEnvironment } from 'src/config/scratch-config.service';
import { assertIsDefined } from 'src/utils/asserts';

export function getPlanTypeFromString(typeString: string): ScratchPlanType | undefined {
  for (const [k, v] of Object.entries(ScratchPlanType)) {
    if (k === typeString) {
      return v;
    }
  }
  return undefined;
}

export interface PlanFeatures {
  // The maximum number of publishing actions that the user can perform. 0 means unlimited.
  publishingLimit: number;
  // The maximum number of data sources per service that the user can use. 0 means unlimited.
  dataSourcePerServiceLimit: number;
}

export interface Plan {
  planType: ScratchPlanType;
  costUSD: number;
  displayName: string;
  stripeProductId: string;
  stripePriceIds: string[];
  popular: boolean;
  hidden: boolean;
  features: PlanFeatures;
}

/**
 * Free Plan
 *
 * This plan is doesn't actually exist on Stripe and is the default plan for users who don't have a subscription.
 *
 * Once a user has a subscription (active or expired), they never go back to the free plan.
 */
export const FREE_PLAN: Plan = {
  planType: ScratchPlanType.FREE_PLAN,
  costUSD: 0,
  displayName: 'Free',
  stripeProductId: 'free_plan',
  stripePriceIds: ['free_plan'],
  popular: false,
  hidden: false,
  features: {
    publishingLimit: 10,
    dataSourcePerServiceLimit: 0,
  },
};

/**
 * Pro Plan
 *
 * This plan is a paid plan that allows users to use the product with unlimited publishing actions and credits.
 */
export const PRO_PLAN: Plan = {
  planType: ScratchPlanType.PRO_PLAN,
  costUSD: 20,
  displayName: 'Pro',
  stripeProductId: '', // Set differently for each environment
  stripePriceIds: [], // Set differently for each environment
  popular: true,
  hidden: false,
  features: {
    publishingLimit: 0,
    dataSourcePerServiceLimit: 0,
  },
};

export const MAX_PLAN: Plan = {
  planType: ScratchPlanType.MAX_PLAN,
  costUSD: 100,
  displayName: 'Max',
  stripeProductId: '', // Set differently for each environment
  stripePriceIds: [], // Set differently for each environment
  popular: false,
  hidden: false,
  features: {
    publishingLimit: 0,
    dataSourcePerServiceLimit: 0,
  },
};

// Plans configured in the Scratch Test sandbox environment for developer testing
export const TEST_SANDBOX_PLANS: Plan[] = [
  FREE_PLAN,
  { ...PRO_PLAN, stripeProductId: 'prod_TVV4n4JqTQnENy', stripePriceIds: ['price_1SYU4jBdRE0kMHNq4mMMjgWH'] },
  { ...MAX_PLAN, stripeProductId: 'prod_TVV6aVZ43QYJmO', stripePriceIds: ['price_1SYU6CBdRE0kMHNqr7YRm7uu'] },
];

// Plans configured in the Scratch Staging sandbox environment
export const STAGING_SANDBOX_PLANS: Plan[] = [
  FREE_PLAN,
  { ...PRO_PLAN, stripeProductId: 'prod_TVXbDaLac1BeEs', stripePriceIds: ['price_1SYWWVPd1pp0ErHMfWTsG55n'] },
  { ...MAX_PLAN, stripeProductId: 'prod_TVXeZZtBUz1VRA', stripePriceIds: ['price_1SYWZDPd1pp0ErHMwtBs7ycN'] },
];

// Plans configured in the Stripe Production environment
export const PRODUCTION_PLANS: Plan[] = [
  FREE_PLAN,
  {
    ...PRO_PLAN,
    stripeProductId: 'prod_TVXVbCVSdlGOjc',
    stripePriceIds: [
      'price_1SYWQ2BuGFTHqsGmiLNoiPCv',
      'price_1T2cQxBuGFTHqsGmBOQjhThc', // This is an archived price ID for $5 that is here for Viktor
    ],
  },
  { ...MAX_PLAN, stripeProductId: 'prod_TVXUCHtF58Bzd2', stripePriceIds: ['price_1SYWPuBuGFTHqsGmOtGqjM6E'] },
];

export function getPlans(environment: ScratchEnvironment): Plan[] {
  if (environment === 'production') {
    return PRODUCTION_PLANS;
  } else if (environment === 'staging') {
    return STAGING_SANDBOX_PLANS;
  }
  return TEST_SANDBOX_PLANS;
}

export function getPlan(planType: ScratchPlanType): Plan | undefined {
  return getPlans(ScratchConfigService.getScratchEnvironment()).find((p) => p.planType === planType);
}

export function getFreePlan(): Plan {
  const freePlan = getPlan(ScratchPlanType.FREE_PLAN);
  assertIsDefined<Plan>(freePlan, 'Unable to identify free plan in the system');
  return freePlan;
}
