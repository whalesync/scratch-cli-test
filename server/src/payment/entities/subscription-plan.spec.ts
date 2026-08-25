import { ScratchPlanType } from '@spinner/shared-types';
import { FREE_PLAN, PRODUCTION_PLANS } from '../plans';
import { SubscriptionPlanEntity } from './subscription-plan';

describe('SubscriptionPlanEntity', () => {
  const productionProPlan = PRODUCTION_PLANS.find((plan) => plan.planType === ScratchPlanType.PRO_PLAN);

  it('should expose every purchasable price without leaking the Stripe price id', () => {
    expect(productionProPlan).toBeDefined();
    if (!productionProPlan) {
      return;
    }

    const entity = new SubscriptionPlanEntity(productionProPlan);

    expect(entity.purchasablePrices).toEqual([
      { billingInterval: 'month', costUSD: 20 },
      { billingInterval: 'year', costUSD: 192 },
    ]);
  });

  // DEV-11372: `costUSD` is deprecated but still on the wire — a desktop build older than annual
  // billing renders `${plan.costUSD}/month`, so it must keep receiving the monthly list price rather
  // than undefined. Delete this test along with the field once those builds have rolled forward.
  it('should keep the deprecated costUSD field populated with the monthly list price', () => {
    expect(productionProPlan).toBeDefined();
    if (!productionProPlan) {
      return;
    }

    expect(new SubscriptionPlanEntity(productionProPlan).costUSD).toBe(20);
  });

  it('should report a zero deprecated costUSD for a plan that is not sold monthly', () => {
    expect(new SubscriptionPlanEntity(FREE_PLAN).costUSD).toBe(0);
    expect(new SubscriptionPlanEntity(FREE_PLAN).purchasablePrices).toEqual([]);
  });
});
