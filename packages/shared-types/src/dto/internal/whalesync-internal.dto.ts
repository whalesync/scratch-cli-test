// Contracts for the internal, admin-only Whalesync → Scratch channel (`/internal/whalesync/*`).
// Request bodies are validated server-side via the shared zod schema (createZodDto bridge).
import { z } from 'zod';

// ── Subscription payload (shared by the sessions and subscription endpoints) ────

/** The Live Export sync cadence a Whalesync subscription grants. */
export const liveExportCadenceSchema = z.enum(['daily', 'hourly', 'frequent']);
export type LiveExportCadence = z.infer<typeof liveExportCadenceSchema>;

/**
 * The Whalesync-side subscription status. `cancelled`/`expired`/`none` all mean "no longer entitled";
 * only `active` grants (or keeps) the Whalesync plan. Note the British `cancelled` spelling here maps to
 * Stripe's American `canceled` on the Scratch `Subscription.stripeStatus` column.
 */
export const whalesyncSubscriptionStatusSchema = z.enum(['none', 'active', 'cancelled', 'expired']);
export type WhalesyncSubscriptionStatus = z.infer<typeof whalesyncSubscriptionStatusSchema>;

/**
 * The subscription state Whalesync sends to Scratch — on session creation (`POST /sessions`) and on any
 * later status change (`PATCH /subscription`). `status` drives whether the Whalesync plan is granted or
 * revoked; the remaining fields are stored verbatim in `Subscription.metadata` and (for now) only recorded
 * — enforcing the Live Export limits against them is a follow-up.
 */
export const whalesyncSubscriptionPayloadSchema = z.object({
  status: whalesyncSubscriptionStatusSchema,
  whalesyncProductType: z.string().optional(),
  liveExportRecordCountLimit: z.number().int().nonnegative().optional(),
  liveExportCadence: liveExportCadenceSchema.optional(),
  /**
   * When the Whalesync subscription expires, as a UTC ISO-8601 timestamp. When present it replaces the
   * internal plan's nominal ~100-year expiry on the Scratch `Subscription.expiration` column, so the plan
   * genuinely lapses on Whalesync's schedule. When omitted the nominal far-future expiry is used.
   */
  expiresAt: z.string().datetime().optional(),
});
export type WhalesyncSubscriptionPayload = z.infer<typeof whalesyncSubscriptionPayloadSchema>;

// ── Request DTOs ──────────────────────────────────────────────────────────────

export const whalesyncShadowUserSchema = z.object({
  whalesyncUserId: z.string().min(1),
  email: z.string().min(1),
  name: z.string().optional(),
  /**
   * Optional Whalesync subscription state to apply while provisioning. Optional for backwards
   * compatibility until the Whalesync backend starts sending it; when omitted the shadow user is granted
   * the Whalesync plan (the historical auto-subscribe behavior).
   */
  subscription: whalesyncSubscriptionPayloadSchema.optional(),
});

export type WhalesyncShadowUserDto = z.infer<typeof whalesyncShadowUserSchema>;

/**
 * Body for `PATCH /internal/whalesync/subscription`. Whalesync calls this whenever a subscription's status
 * changes on their side (expire / cancel / upgrade). The user is identified in-body since the path carries
 * no id. Only a `WHALESYNC_PLAN` subscription is mutated — a real Scratch Stripe subscription yields a 409.
 */
export const whalesyncUpdateSubscriptionSchema = z.object({
  whalesyncUserId: z.string().min(1),
  subscription: whalesyncSubscriptionPayloadSchema,
});

export type WhalesyncUpdateSubscriptionDto = z.infer<typeof whalesyncUpdateSubscriptionSchema>;

// ── Response Entities ─────────────────────────────────────────────────────────

export interface WhalesyncSessionResponse {
  scratchUserId: string;
  apiToken: string;
  /** UTC ISO-8601 timestamp; the token expires 10 minutes after it is minted. */
  expiresAt: string;
}

export interface WhalesyncUserResponse {
  scratchUserId: string;
}

export interface WhalesyncRevokeSessionsResponse {
  revoked: number;
}

export interface WhalesyncClearSubscriptionResponse {
  /** The Scratch user whose Whalesync plan was cleared, or `null` when no shadow user exists. */
  scratchUserId: string | null;
  /** True when a Whalesync-plan subscription row was deleted; false when there was nothing to clear. */
  cleared: boolean;
}

export interface WhalesyncUpdateSubscriptionResponse {
  /** The Scratch user whose subscription was updated, or `null` when no shadow user exists. */
  scratchUserId: string | null;
  /** True when a Whalesync-plan subscription row was created or updated; false for a no-op. */
  updated: boolean;
  /** The resulting plan type of the user's subscription, or `null` when there is no shadow user / no sub. */
  planType: string | null;
}

/**
 * The typed shape stored in `Subscription.metadata` for Whalesync-plan subscriptions. All fields optional
 * — Whalesync may send a partial payload. Persisted as JSON; read back to drive Live Export gating (future).
 */
export interface WhalesyncSubscriptionMetadata {
  /** The last Whalesync-side status we were told about (before mapping to `stripeStatus`). */
  whalesyncStatus?: WhalesyncSubscriptionStatus;
  whalesyncProductType?: string;
  liveExportRecordCountLimit?: number;
  liveExportCadence?: LiveExportCadence;
}
