// Contracts for the two internal, server-to-server channels between Scratch and Whalesync:
// - Whalesync → Scratch (`/internal/whalesync/*`, admin-only). Request bodies are validated server-side via the
//   shared zod schema (createZodDto bridge).
// - Scratch → Whalesync (bottlenose's `/internal/scratch/*`). Scratch validates each body against the shared zod
//   schema before sending it; bottlenose hand-mirrors the schema.
import { z } from 'zod';
import type { RoutineRunStatus, RoutineRunTrigger } from '../../db/routine-run';
import { LiveExportEngine } from '../../live-export/live-export-engine';

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

/**
 * Who a session or shadow user is for. A shadow user holds the Live Exports of one Whalesync team (DEV-13019), so
 * `whalesyncTeamId` is its identity and `whalesyncUserId` is the person acting in that team. Without a team id the
 * shadow user is found and created by `whalesyncUserId` alone, as before teams, which is how a Whalesync backend that
 * hasn't deployed its side yet still calls.
 */
export const whalesyncShadowUserSchema = z.object({
  /** The Whalesync person acting. Recorded on the session token it mints. */
  whalesyncUserId: z.string().min(1),
  /** The Whalesync team (`tm_…`) the person is working in. */
  whalesyncTeamId: z.string().min(1).optional(),
  /**
   * Whether the person is the team's only member, which makes their own shadow user and their team's the same one.
   * Only then is a shadow user made for the person before teams taken as the team's, and only then does a shadow
   * user created for the team also carry the person's id. Left out, it counts as false.
   */
  whalesyncUserIsTeamsOnlyMember: z.boolean().optional(),
  /** The person's email. Not stored on a shadow user created for a team, which has no email of its own. */
  email: z.string().min(1),
  /** A label for the shadow user: the team's name, or the person's for a team with no name. */
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
export const whalesyncUpdateSubscriptionSchema = z
  .object({
    /**
     * The team whose plan changed. When no shadow user carries it yet, `whalesyncUserId` finds the shadow user made
     * for the team's one member before teams, and the team id is recorded on it.
     */
    whalesyncTeamId: z.string().min(1).optional(),
    whalesyncUserId: z.string().min(1).optional(),
    subscription: whalesyncSubscriptionPayloadSchema,
  })
  .refine((body) => body.whalesyncTeamId !== undefined || body.whalesyncUserId !== undefined, {
    message: 'whalesyncTeamId or whalesyncUserId is required',
  });

export type WhalesyncUpdateSubscriptionDto = z.infer<typeof whalesyncUpdateSubscriptionSchema>;

/** How many shadow users one team link request may name, and how many one page of unlinked ones lists. */
export const WHALESYNC_TEAM_LINK_BATCH_LIMIT = 500;

/**
 * Body for `POST /internal/whalesync/team-links`: the team of each Whalesync person whose shadow user predates teams.
 * Whalesync reads the people from `GET /internal/whalesync/team-links/pending` and answers with their teams.
 */
export const whalesyncLinkTeamsSchema = z.object({
  links: z
    .array(z.object({ whalesyncUserId: z.string().min(1), whalesyncTeamId: z.string().min(1) }))
    .max(WHALESYNC_TEAM_LINK_BATCH_LIMIT),
});

export type WhalesyncLinkTeamsDto = z.infer<typeof whalesyncLinkTeamsSchema>;

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

/** One of a shadow user's Live Exports (a `ws_export` workbook), as listed for Whalesync's admin dev tools. */
export interface WhalesyncLiveExportSummary {
  /** The workbook id (`wkb_…`), which is also the id in Whalesync's `/exports/<id>` URL. */
  id: string;
  /** Null until the user names it. */
  name: string | null;
  /** UTC ISO-8601 timestamp. */
  createdAt: string;
  /** UTC ISO-8601 timestamp. */
  updatedAt: string;
}

export interface WhalesyncListLiveExportsResponse {
  /** Newest first. Empty when no shadow user exists. Excludes workbooks pending deletion. */
  liveExports: WhalesyncLiveExportSummary[];
}

export interface WhalesyncPendingTeamLinksResponse {
  /**
   * Whalesync user ids of shadow users with no team id yet, in ascending order, at most
   * `WHALESYNC_TEAM_LINK_BATCH_LIMIT`. Pass the last one as `after` for the next page; an empty list is the end.
   */
  whalesyncUserIds: string[];
}

/** Why a requested team link was not made. */
export type WhalesyncTeamLinkSkipReason =
  /** No shadow user is linked to that Whalesync user. */
  | 'no_shadow_user'
  /** The shadow user already carries a different team id. */
  | 'linked_to_another_team'
  /** Another shadow user already carries that team id. */
  | 'team_has_another_shadow_user';

export interface WhalesyncLinkTeamsResponse {
  /** Shadow users that got their team id from this request. */
  linked: number;
  /** Shadow users that already carried the requested team id. */
  alreadyLinked: number;
  skipped: { whalesyncUserId: string; whalesyncTeamId: string; reason: WhalesyncTeamLinkSkipReason }[];
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

// ── Scratch → Whalesync: Live Export run notifications (DEV-12330) ────────────

/** Path, relative to Whalesync's internal API base URL, that Scratch POSTs a finished Live Export run to. */
export const LIVE_EXPORT_RUN_FINISHED_NOTIFICATION_PATH = '/internal/scratch/live-export-runs/finished';

/** Header carrying the shared service token on every Scratch → Whalesync call (`/internal/scratch/*`). */
export const SCRATCH_SERVICE_TOKEN_HEADER = 'X-Scratch-Service-Token';

/** Every `RoutineRunStatus`, as an enum-like object, so the zod enum below can't drift from the TS union. */
const ROUTINE_RUN_STATUS_VALUES = {
  pending: 'pending',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
} as const satisfies { readonly [Status in RoutineRunStatus]: Status };

/** Every `RoutineRunTrigger`, as an enum-like object, so the zod enum below can't drift from the TS union. */
const ROUTINE_RUN_TRIGGER_VALUES = {
  manual: 'manual',
  schedule: 'schedule',
} as const satisfies { readonly [Trigger in RoutineRunTrigger]: Trigger };

/**
 * Body of `POST {WHALESYNC_INTERNAL_API_URL}/internal/scratch/live-export-runs/finished`: one Live Export run that
 * reached a terminal state, as Scratch recorded it. Whalesync (bottlenose) emails the export's team when the run
 * failed. This schema is the canonical contract: bottlenose hand-mirrors it (`live-export-run-finished.dto.ts`), and
 * Scratch validates every body against it before queuing it. `status` is on the wire even though Scratch only sends
 * failed runs today, so runs that complete with warnings can be added without a contract change.
 */
export const liveExportRunFinishedNotificationSchema = z
  .object({
    /**
     * The Whalesync team (`tm_…`) the Live Export belongs to: the team of the shadow user that owns the workbook
     * (DEV-13019). Absent for a shadow user made before teams that hasn't been given its team yet.
     */
    whalesyncTeamId: z.string().min(1).optional(),
    /**
     * The Whalesync person the workbook's shadow user was made for, before teams. Whalesync works the team out from
     * them when `whalesyncTeamId` is absent. Absent for a shadow user made for a team.
     */
    whalesyncUserId: z.uuid().optional(),
    /** The Scratch workbook that is the Live Export (`wkb_…`). */
    workbookId: z.string().min(1),
    /** The Live Export's name as Whalesync shows it: the workbook name, or "Untitled export" when it has none. */
    workbookName: z.string(),
    routineFilePath: z.string(),
    /** The routine run (`rrn_…`). Whalesync's dedup key. */
    runId: z.string().min(1),
    status: z.enum(ROUTINE_RUN_STATUS_VALUES),
    trigger: z.enum(ROUTINE_RUN_TRIGGER_VALUES),
    /** When the run reached its terminal state, as a UTC ISO-8601 timestamp. */
    finishedAt: z.string().datetime(),
    /** The failing step's own message (or the last step's summary when the run completed). */
    resultSummary: z.string().nullable(),
    /** Set when the run completed but a step finished with a warning. */
    resultWarning: z.string().nullable(),
    /** The older, prefixed form of the failure ("Step N (action) failed: …"). */
    error: z.string().nullable(),
    liveExportEngine: z.enum(LiveExportEngine).nullable(),
  })
  .refine((notification) => notification.whalesyncTeamId !== undefined || notification.whalesyncUserId !== undefined, {
    message: 'whalesyncTeamId or whalesyncUserId is required',
  });

export type LiveExportRunFinishedNotificationDto = z.infer<typeof liveExportRunFinishedNotificationSchema>;

/**
 * What Whalesync did with a pushed run. Each one is a handled case answered with a 200, so Scratch counts the run as
 * delivered:
 * - `emailed`: emailed the export's owner.
 * - `muted`: the owner turned Live Export failure emails off.
 * - `throttled`: the owner was already emailed about a Live Export failure within the last day.
 * - `disabled`: failure emails are switched off in that Whalesync environment.
 * - `unknown_user`: no live Whalesync user has that id.
 * - `duplicate`: the run was already handled.
 * - `ignored_status`: a status Whalesync does not act on yet (anything but `failed`).
 */
export const LIVE_EXPORT_RUN_NOTIFICATION_OUTCOMES = [
  'emailed',
  'muted',
  'throttled',
  'disabled',
  'unknown_user',
  'duplicate',
  'ignored_status',
] as const;

export type LiveExportRunNotificationOutcome = (typeof LIVE_EXPORT_RUN_NOTIFICATION_OUTCOMES)[number];

export interface LiveExportRunFinishedNotificationResponse {
  outcome: LiveExportRunNotificationOutcome;
}
