import { ScratchPlanType } from '@spinner/shared-types';
import { ScratchConfigService, ScratchEnvironment } from '../config/scratch-config.service';
import {
  getAllStripePriceIdsForPlan,
  getPlan,
  getPlanPriceForBillingInterval,
  getPlans,
  getPlanTypeForStripePriceId,
  getPlanTypeFromString,
  getStripePriceIdForPlanAndBillingInterval,
  Plan,
  PRO_PLAN,
  PRODUCTION_PLANS,
  STAGING_SANDBOX_PLANS,
  TEST_SANDBOX_PLANS,
} from './plans';

describe('plans', () => {
  describe('getPlanTypeFromString', () => {
    it('should return the correct plan type for a valid string', () => {
      expect(getPlanTypeFromString('PRO_PLAN')).toBe(ScratchPlanType.PRO_PLAN);
      expect(getPlanTypeFromString('MAX_PLAN')).toBe(ScratchPlanType.MAX_PLAN);
      expect(getPlanTypeFromString('FREE_PLAN')).toBe(ScratchPlanType.FREE_PLAN);
    });

    it('should return undefined for an invalid string', () => {
      expect(getPlanTypeFromString('INVALID_PLAN')).toBeUndefined();
    });

    it('should return undefined for an empty string', () => {
      expect(getPlanTypeFromString('')).toBeUndefined();
    });

    it('should return undefined for a lowercase string', () => {
      expect(getPlanTypeFromString('starter_plan')).toBeUndefined();
    });

    it('should return undefined for a partial match', () => {
      expect(getPlanTypeFromString('FREE')).toBeUndefined();
    });
  });

  describe('getPlans', () => {
    it('should return production plans for production environment', () => {
      const plans = getPlans('production' as ScratchEnvironment);
      expect(plans).toBe(PRODUCTION_PLANS);
      expect(plans).toHaveLength(4);
      expect(plans.find((p) => p.planType === ScratchPlanType.FREE_PLAN)).toBeDefined();
      expect(plans.find((p) => p.planType === ScratchPlanType.PRO_PLAN)).toBeDefined();
      expect(plans.find((p) => p.planType === ScratchPlanType.MAX_PLAN)).toBeDefined();
      expect(plans.find((p) => p.planType === ScratchPlanType.WHALESYNC_PLAN)).toBeDefined();
    });

    it('should return staging plans for staging environment', () => {
      const plans = getPlans('staging' as ScratchEnvironment);
      expect(plans).toBe(STAGING_SANDBOX_PLANS);
      expect(plans).toHaveLength(4);
      expect(plans.find((p) => p.planType === ScratchPlanType.FREE_PLAN)).toBeDefined();
      expect(plans.find((p) => p.planType === ScratchPlanType.PRO_PLAN)).toBeDefined();
      expect(plans.find((p) => p.planType === ScratchPlanType.MAX_PLAN)).toBeDefined();
      expect(plans.find((p) => p.planType === ScratchPlanType.WHALESYNC_PLAN)).toBeDefined();
    });

    it('should return test plans for test environment', () => {
      const plans = getPlans('test' as ScratchEnvironment);
      expect(plans).toBe(TEST_SANDBOX_PLANS);
      expect(plans).toHaveLength(4);
      expect(plans.find((p) => p.planType === ScratchPlanType.FREE_PLAN)).toBeDefined();
      expect(plans.find((p) => p.planType === ScratchPlanType.PRO_PLAN)).toBeDefined();
      expect(plans.find((p) => p.planType === ScratchPlanType.MAX_PLAN)).toBeDefined();
      expect(plans.find((p) => p.planType === ScratchPlanType.WHALESYNC_PLAN)).toBeDefined();
    });

    it('should return test plans for local environment', () => {
      const plans = getPlans('local' as ScratchEnvironment);
      expect(plans).toBe(TEST_SANDBOX_PLANS);
      expect(plans).toHaveLength(4);
    });

    it('should return test plans for any other environment', () => {
      const plans = getPlans('unknown' as ScratchEnvironment);
      expect(plans).toBe(TEST_SANDBOX_PLANS);
    });
  });

  describe('getPlan', () => {
    beforeEach(() => {
      // Mock the static method to return test environment
      jest.spyOn(ScratchConfigService, 'getScratchEnvironment').mockReturnValue('test');
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should return the correct plan for PRO_PLAN', () => {
      const plan = getPlan(ScratchPlanType.PRO_PLAN);
      expect(plan).toBeDefined();
      expect(plan?.planType).toBe(ScratchPlanType.PRO_PLAN);
      expect(plan?.displayName).toBe(PRO_PLAN.displayName);
    });

    it('should return undefined for a non-existent plan', () => {
      const plan = getPlan('NON_EXISTENT_PLAN' as ScratchPlanType);
      expect(plan).toBeUndefined();
    });
  });

  describe('Plan interface structure', () => {
    const ALL_ENVIRONMENT_PLAN_TABLES: [string, Plan[]][] = [
      ['production', PRODUCTION_PLANS],
      ['staging', STAGING_SANDBOX_PLANS],
      ['test', TEST_SANDBOX_PLANS],
    ];

    it.each(ALL_ENVIRONMENT_PLAN_TABLES)('should have all required fields in %s plans', (_environment, plans) => {
      plans.forEach((plan: Plan) => {
        expect(typeof plan.planType).toBe('string');
        expect(typeof plan.displayName).toBe('string');
        expect(typeof plan.stripeProductId).toBe('string');
        expect(Array.isArray(plan.purchasablePrices)).toBe(true);
        expect(Array.isArray(plan.legacyStripePriceIds)).toBe(true);
      });
    });

    it.each(ALL_ENVIRONMENT_PLAN_TABLES)(
      'should sell each %s plan at most once per billing interval',
      (_environment, plans) => {
        plans.forEach((plan: Plan) => {
          const billingIntervals = plan.purchasablePrices.map((price) => price.billingInterval);
          expect(new Set(billingIntervals).size).toBe(billingIntervals.length);
        });
      },
    );

    it.each(ALL_ENVIRONMENT_PLAN_TABLES)('should price every %s plan above zero', (_environment, plans) => {
      plans.forEach((plan: Plan) => {
        plan.purchasablePrices.forEach((price) => expect(price.costUSD).toBeGreaterThan(0));
      });
    });

    it('should have unique stripe product IDs across all environments', () => {
      const allPlans = [...PRODUCTION_PLANS, ...STAGING_SANDBOX_PLANS, ...TEST_SANDBOX_PLANS];
      // Free and Whalesync are internal plans with no real Stripe product, so exclude them.
      const plansWithStripeProducts = allPlans.filter(
        (p) => p.planType !== ScratchPlanType.FREE_PLAN && p.planType !== ScratchPlanType.WHALESYNC_PLAN,
      );
      const productIds = plansWithStripeProducts.map((p) => p.stripeProductId);
      const uniqueProductIds = new Set(productIds);
      expect(uniqueProductIds.size).toBe(productIds.length);
    });

    it('should have unique stripe price IDs across all environments', () => {
      const allPlans = [...PRODUCTION_PLANS, ...STAGING_SANDBOX_PLANS, ...TEST_SANDBOX_PLANS];
      // Free and Whalesync are internal plans with no real Stripe price, so exclude them.
      const plansWithStripePrices = allPlans.filter(
        (p) => p.planType !== ScratchPlanType.FREE_PLAN && p.planType !== ScratchPlanType.WHALESYNC_PLAN,
      );
      const priceIds = plansWithStripePrices.flatMap(getAllStripePriceIdsForPlan);
      const uniquePriceIds = new Set(priceIds);
      expect(uniquePriceIds.size).toBe(priceIds.length);
    });

    it('should keep the retired Max plan hidden but still resolvable in every environment', () => {
      // Max is off the public list, but its Stripe price must keep resolving or the subscriptions
      // still live on it would be stranded by upsertSubscription. See MAX_PLAN in plans.ts.
      const environmentsWithPlans = [
        ['production', PRODUCTION_PLANS],
        ['staging', STAGING_SANDBOX_PLANS],
        ['test', TEST_SANDBOX_PLANS],
      ] as const;

      environmentsWithPlans.forEach(([environment, plans]) => {
        const maxPlan = plans.find((p) => p.planType === ScratchPlanType.MAX_PLAN);
        expect(maxPlan?.hidden).toBe(true);
        const maxPriceIds = maxPlan ? getAllStripePriceIdsForPlan(maxPlan) : [];
        expect(maxPriceIds.length).toBeGreaterThan(0);
        maxPriceIds.forEach((stripePriceId) => {
          expect(getPlanTypeForStripePriceId(environment, stripePriceId)).toBe(ScratchPlanType.MAX_PLAN);
        });
      });
    });

    it('should not sell the internal Free and Whalesync plans at any interval', () => {
      const allPlans = [...PRODUCTION_PLANS, ...STAGING_SANDBOX_PLANS, ...TEST_SANDBOX_PLANS];
      const internalPlans = allPlans.filter(
        (p) => p.planType === ScratchPlanType.FREE_PLAN || p.planType === ScratchPlanType.WHALESYNC_PLAN,
      );
      expect(internalPlans.length).toBeGreaterThan(0);
      internalPlans.forEach((plan) => {
        expect(getAllStripePriceIdsForPlan(plan)).toEqual([]);
      });
    });

    it('should have the same display name across all environments for the same product type', () => {
      const productionPlan = PRODUCTION_PLANS.find((p) => p.planType === ScratchPlanType.PRO_PLAN);
      const stagingPlan = STAGING_SANDBOX_PLANS.find((p) => p.planType === ScratchPlanType.PRO_PLAN);
      const testPlan = TEST_SANDBOX_PLANS.find((p) => p.planType === ScratchPlanType.PRO_PLAN);

      expect(productionPlan?.displayName).toBe(PRO_PLAN.displayName);
      expect(stagingPlan?.displayName).toBe(PRO_PLAN.displayName);
      expect(testPlan?.displayName).toBe(PRO_PLAN.displayName);
    });
  });

  describe('getStripePriceIdForPlanAndBillingInterval', () => {
    it('should return the monthly price for the production Pro plan', () => {
      expect(getStripePriceIdForPlanAndBillingInterval('production', ScratchPlanType.PRO_PLAN, 'month')).toBe(
        'price_1SYWQ2BuGFTHqsGmiLNoiPCv',
      );
    });

    it('should return the annual price for the production Pro plan', () => {
      expect(getStripePriceIdForPlanAndBillingInterval('production', ScratchPlanType.PRO_PLAN, 'year')).toBe(
        'price_1U82nOBuGFTHqsGmNkIi8R7e',
      );
    });

    it('should return null for an interval the plan is not sold at', () => {
      // Max is monthly-only in every environment.
      expect(getStripePriceIdForPlanAndBillingInterval('production', ScratchPlanType.MAX_PLAN, 'year')).toBeNull();
    });

    it('should return null for plans that are never purchased through Stripe', () => {
      expect(getStripePriceIdForPlanAndBillingInterval('production', ScratchPlanType.FREE_PLAN, 'month')).toBeNull();
      expect(
        getStripePriceIdForPlanAndBillingInterval('production', ScratchPlanType.WHALESYNC_PLAN, 'month'),
      ).toBeNull();
    });

    it('should never hand back a legacy price id for checkout', () => {
      const legacyProPriceId = 'price_1T2cQxBuGFTHqsGmBOQjhThc';
      const purchasableProPriceIds = (['month', 'year'] as const).map((billingInterval) =>
        getStripePriceIdForPlanAndBillingInterval('production', ScratchPlanType.PRO_PLAN, billingInterval),
      );
      expect(purchasableProPriceIds).not.toContain(legacyProPriceId);
    });
  });

  describe('getPlanTypeForStripePriceId', () => {
    // DEV-11372: an unregistered price id resolves to null, which makes upsertSubscription reject the
    // webhook — the customer is charged but never granted the plan. Every price we can be billed at
    // must therefore resolve, annual and legacy ones included.
    it('should resolve the production annual Pro price to the Pro plan', () => {
      expect(getPlanTypeForStripePriceId('production', 'price_1U82nOBuGFTHqsGmNkIi8R7e')).toBe(
        ScratchPlanType.PRO_PLAN,
      );
    });

    it('should resolve the production monthly Pro price to the Pro plan', () => {
      expect(getPlanTypeForStripePriceId('production', 'price_1SYWQ2BuGFTHqsGmiLNoiPCv')).toBe(
        ScratchPlanType.PRO_PLAN,
      );
    });

    it('should still resolve the archived legacy Pro price', () => {
      expect(getPlanTypeForStripePriceId('production', 'price_1T2cQxBuGFTHqsGmBOQjhThc')).toBe(
        ScratchPlanType.PRO_PLAN,
      );
    });

    it('should resolve every purchasable price in every environment', () => {
      const environmentsWithPlans = [
        ['production', PRODUCTION_PLANS],
        ['staging', STAGING_SANDBOX_PLANS],
        ['test', TEST_SANDBOX_PLANS],
      ] as const;

      environmentsWithPlans.forEach(([environment, plans]) => {
        plans.forEach((plan) => {
          getAllStripePriceIdsForPlan(plan).forEach((stripePriceId) => {
            expect(getPlanTypeForStripePriceId(environment, stripePriceId)).toBe(plan.planType);
          });
        });
      });
    });

    it('should return null for a price id we do not know about', () => {
      expect(getPlanTypeForStripePriceId('production', 'price_not_a_real_price')).toBeNull();
    });

    it('should not resolve a production price against a sandbox environment', () => {
      expect(getPlanTypeForStripePriceId('test', 'price_1U82nOBuGFTHqsGmNkIi8R7e')).toBeNull();
    });
  });

  describe('getPlanPriceForBillingInterval', () => {
    it('should return the annual list price for the production Pro plan', () => {
      const productionProPlan = PRODUCTION_PLANS.find((p) => p.planType === ScratchPlanType.PRO_PLAN);
      expect(productionProPlan).toBeDefined();
      expect(productionProPlan && getPlanPriceForBillingInterval(productionProPlan, 'year')).toEqual({
        billingInterval: 'year',
        costUSD: 192,
        stripePriceId: 'price_1U82nOBuGFTHqsGmNkIi8R7e',
      });
    });

    it('should return null when the plan is not sold at that interval', () => {
      const productionMaxPlan = PRODUCTION_PLANS.find((p) => p.planType === ScratchPlanType.MAX_PLAN);
      expect(productionMaxPlan).toBeDefined();
      expect(productionMaxPlan && getPlanPriceForBillingInterval(productionMaxPlan, 'year')).toBeNull();
    });
  });

  describe('ScratchPlanType enum', () => {
    it('should have PRO_PLAN defined', () => {
      expect(ScratchPlanType.PRO_PLAN).toBe(ScratchPlanType.PRO_PLAN);
    });

    it('should only have expected plan types', () => {
      const planTypes = Object.values(ScratchPlanType);
      expect(planTypes).toHaveLength(4);
      expect(planTypes).toContain(ScratchPlanType.FREE_PLAN);
      expect(planTypes).toContain(ScratchPlanType.PRO_PLAN);
      expect(planTypes).toContain(ScratchPlanType.MAX_PLAN);
      expect(planTypes).toContain(ScratchPlanType.WHALESYNC_PLAN);
    });
  });
});
