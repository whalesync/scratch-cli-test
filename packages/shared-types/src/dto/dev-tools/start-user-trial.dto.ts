import { z } from 'zod';
import { ScratchPlanType } from '../../subscription';

/**
 * Body for the admin "grant a free trial" dev tool (`POST /dev-tools/users/:id/start-trial`). The
 * target user id comes from the path; the body only carries the optional plan tier to put the trial
 * on, defaulting to the Pro plan on the server when omitted.
 */
export const startUserTrialSchema = z.object({
  planType: z.nativeEnum(ScratchPlanType).optional(),
});

export type StartUserTrialDto = z.infer<typeof startUserTrialSchema>;
