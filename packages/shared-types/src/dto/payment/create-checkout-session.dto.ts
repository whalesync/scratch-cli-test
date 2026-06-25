import { z } from 'zod';

/**
 * Request body for `POST /payment/checkout/:planType`.
 *
 * This is the single source of truth for the checkout request shape: the server
 * validates against it (via `createZodDto` + the global `ZodValidationPipe`) and
 * the client can both type against `CreateCheckoutSessionBody` and run
 * `createCheckoutSessionSchema.parse(...)` directly in the browser if it wants
 * to validate before sending.
 */
export const createCheckoutSessionSchema = z.object({
  returnPath: z.string().optional(),
  /**
   * Path (relative to the web client base URL) Stripe returns to when the user CANCELS checkout.
   * Defaults server-side to the web billing page. The desktop app passes its bounce-page path here so a
   * cancelled checkout redirects back into the desktop app instead of stranding the user on the web client.
   */
  cancelPath: z.string().optional(),
});

export type CreateCheckoutSessionBody = z.infer<typeof createCheckoutSessionSchema>;

export type CreateCheckoutSessionResponse = {
  url: string;
};
