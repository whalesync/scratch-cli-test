import { z } from 'zod';
import { ScratchPlanType } from '../../subscription';

export const createPortalSchema = z.object({
  portalType: z.enum(['cancel_subscription', 'update_subscription', 'manage_payment_methods']).optional(),
  returnPath: z.string().optional(),
  planType: z.nativeEnum(ScratchPlanType).optional(),
});

export type CreatePortalDto = z.infer<typeof createPortalSchema>;

export type CreateCustomerPortalUrlResponse = {
  url: string;
};
