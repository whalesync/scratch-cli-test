import { z } from 'zod';
import { ScratchPlanType } from '../../subscription';

export const updateDevSubscriptionSchema = z.object({
  planType: z.nativeEnum(ScratchPlanType),
});

export type UpdateDevSubscriptionDto = z.infer<typeof updateDevSubscriptionSchema>;
