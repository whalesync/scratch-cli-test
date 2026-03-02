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
  // The limited set of models that the user can use. If the array is empty, all models are available.
  availableModels: string[];
  // The maximum number of publishing actions that the user can perform. 0 means unlimited.
  publishingLimit: number;
  // The maximum number of credits that the user can use. 0 means unlimited.
  creditLimit: number;
  // The frequency at which the user's credits are reset.
  creditReset: 'daily' | 'weekly' | 'monthly' | 'never';
  // Whether the user is allowed to use personal OpenRouter API keys and create custom credentials
  allowPersonalKeys: boolean;
  // The maximum number of data sources per service that the user can use. 0 means unlimited.
  dataSourcePerServiceLimit: number;
}

export interface Plan {
  planType: ScratchPlanType;
  costUSD: number;
  displayName: string;
  stripeProductId: string;
  stripePriceId: string;
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
  stripePriceId: 'free_plan',
  popular: false,
  hidden: false,
  features: {
    availableModels: [
      'x-ai/grok-4.1-fast',
      'google/gemini-2.5-flash',
      'openai/gpt-4o-mini',
      'anthropic/claude-haiku-4.5',
      'openai/gpt-oss-120b',
      'google/gemini-3-pro-preview',
    ],
    publishingLimit: 10,
    creditLimit: 5,
    creditReset: 'monthly',
    allowPersonalKeys: false,
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
  stripePriceId: '', // Set differently for each environment
  popular: true,
  hidden: false,
  features: {
    availableModels: [],
    publishingLimit: 0,
    creditLimit: 10,
    creditReset: 'monthly',
    allowPersonalKeys: true,
    dataSourcePerServiceLimit: 0,
  },
};

export const MAX_PLAN: Plan = {
  planType: ScratchPlanType.MAX_PLAN,
  costUSD: 100,
  displayName: 'Max',
  stripeProductId: '', // Set differently for each environment
  stripePriceId: '', // Set differently for each environment
  popular: false,
  hidden: false,
  features: {
    availableModels: [],
    publishingLimit: 0,
    creditLimit: 50,
    creditReset: 'monthly',
    allowPersonalKeys: true,
    dataSourcePerServiceLimit: 0,
  },
};

// Plans configured in the Scratch Test sandbox environment for developer testing
export const TEST_SANDBOX_PLANS: Plan[] = [
  FREE_PLAN,
  { ...PRO_PLAN, stripeProductId: 'prod_TVV4n4JqTQnENy', stripePriceId: 'price_1SYU4jBdRE0kMHNq4mMMjgWH' },
  { ...MAX_PLAN, stripeProductId: 'prod_TVV6aVZ43QYJmO', stripePriceId: 'price_1SYU6CBdRE0kMHNqr7YRm7uu' },
];

// Plans configured in the Scratch Staging sandbox environment
export const STAGING_SANDBOX_PLANS: Plan[] = [
  FREE_PLAN,
  { ...PRO_PLAN, stripeProductId: 'prod_TVXbDaLac1BeEs', stripePriceId: 'price_1SYWWVPd1pp0ErHMfWTsG55n' },
  { ...MAX_PLAN, stripeProductId: 'prod_TVXeZZtBUz1VRA', stripePriceId: 'price_1SYWZDPd1pp0ErHMwtBs7ycN' },
];

// Plans configured in the Stripe Production environment
export const PRODUCTION_PLANS: Plan[] = [
  FREE_PLAN,
  { ...PRO_PLAN, stripeProductId: 'prod_TVXVbCVSdlGOjc', stripePriceId: 'price_1SYWQ2BuGFTHqsGmiLNoiPCv' },
  { ...MAX_PLAN, stripeProductId: 'prod_TVXUCHtF58Bzd2', stripePriceId: 'price_1SYWPuBuGFTHqsGmOtGqjM6E' },
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
