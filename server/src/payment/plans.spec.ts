import { ScratchPlanType } from '@spinner/shared-types';
import { ScratchConfigService, ScratchEnvironment } from '../config/scratch-config.service';
import {
  getPlan,
  getPlans,
  getPlanTypeFromString,
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
    it('should have all required fields in production plans', () => {
      PRODUCTION_PLANS.forEach((plan: Plan) => {
        expect(plan).toHaveProperty('planType');
        expect(plan).toHaveProperty('displayName');
        expect(plan).toHaveProperty('stripeProductId');
        expect(plan).toHaveProperty('stripePriceIds');
        expect(typeof plan.planType).toBe('string');
        expect(typeof plan.displayName).toBe('string');
        expect(typeof plan.stripeProductId).toBe('string');
        expect(Array.isArray(plan.stripePriceIds)).toBe(true);
      });
    });

    it('should have all required fields in staging plans', () => {
      STAGING_SANDBOX_PLANS.forEach((plan: Plan) => {
        expect(plan).toHaveProperty('planType');
        expect(plan).toHaveProperty('displayName');
        expect(plan).toHaveProperty('stripeProductId');
        expect(plan).toHaveProperty('stripePriceIds');
      });
    });

    it('should have all required fields in test plans', () => {
      TEST_SANDBOX_PLANS.forEach((plan: Plan) => {
        expect(plan).toHaveProperty('planType');
        expect(plan).toHaveProperty('displayName');
        expect(plan).toHaveProperty('stripeProductId');
        expect(plan).toHaveProperty('stripePriceIds');
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
      const priceIds = plansWithStripePrices.flatMap((p) => p.stripePriceIds);
      const uniquePriceIds = new Set(priceIds);
      expect(uniquePriceIds.size).toBe(priceIds.length);
    });

    it('should have identical stripe ids for all free plans', () => {
      const allPlans = [...PRODUCTION_PLANS, ...STAGING_SANDBOX_PLANS, ...TEST_SANDBOX_PLANS];
      // remove the free plans
      const onlyFreePlans = allPlans.filter((p) => p.planType === ScratchPlanType.FREE_PLAN);
      const priceIds = onlyFreePlans.flatMap((p) => p.stripePriceIds);
      const uniquePriceIds = new Set(priceIds);
      expect(uniquePriceIds.size).toBe(1);
      expect(priceIds[0]).toBe('free_plan');
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
