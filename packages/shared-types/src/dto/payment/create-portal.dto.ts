import { z } from 'zod';
import { ScratchPlanType } from '../../subscription';
import { billingIntervalSchema } from './billing-interval.schema';

export const createPortalSchema = z.object({
  portalType: z.enum(['cancel_subscription', 'update_subscription', 'manage_payment_methods']).optional(),
  returnPath: z.string().optional(),
  /**
   * For `update_subscription`, the plan the user picked. Combined with `billingInterval` it selects
   * an exact Stripe price, letting the portal open on a confirm-this-change page instead of the
   * generic "pick a plan" page. Omit both to get the generic flow.
   */
  planType: z.nativeEnum(ScratchPlanType).optional(),
  /** For `update_subscription`, which of `planType`'s prices to switch to. See `planType`. */
  billingInterval: billingIntervalSchema.optional(),
});

export type CreatePortalDto = z.infer<typeof createPortalSchema>;

export type CreateCustomerPortalUrlResponse = {
  url: string;
};
