import { z } from 'zod';

/**
 * zod mirror of the shared `BillingInterval` union (see `src/subscription.ts`), shared by every
 * payment request DTO that lets the caller pick monthly vs annual billing. Keep the members in sync
 * with that union — they are the Stripe price `recurring.interval` values we sell at.
 */
export const billingIntervalSchema = z.enum(['month', 'year']);
