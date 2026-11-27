// Contracts for the two internal, server-to-server channels between Scratch and Whalesync:
// - Whalesync → Scratch (`/internal/whalesync/*`, admin-only). Request bodies are validated server-side via the
//   shared zod schema (createZodDto bridge).
// - Scratch → Whalesync (bottlenose's `/internal/scratch/*`). Scratch validates each body against the shared zod
//   schema before sending it; bottlenose hand-mirrors the schema.
import { z } from 'zod';
import type { RoutineRunStatus, RoutineRunTrigger } from '../../db/routine-run';
import { LiveExportEngine } from '../../live-export/live-export-engine';

// ── Live Export access (the sessions and live-export-access endpoints) ─────────

/**
 * How often a Whalesync plan lets a Live Export run on a schedule, at most: every 10 minutes (`frequent`), once an
 * hour (`hourly`), or once a day (`daily`).
 */
export const liveExportCadenceSchema = z.enum(['daily', 'hourly', 'frequent']);
export type LiveExportCadence = z.infer<typeof liveExportCadenceSchema>;

/**
 * What a Whalesync team's Live Exports may do (DEV-12983). Whalesync works it out from the team's plan and sends the
 * whole of it, on every session (`POST /sessions`) and whenever it changes
 * (`PUT /teams/:whalesyncTeamId/live-export-access`). Scratch carries it out and never reads a Whalesync
 * subscription. A value Whalesync adds here, such as another speed, is never sent until Scratch accepts it in every
 * environment.
 */
export const whalesyncLiveExportAccessSchema = z.object({
  /**
   * While true, Scratch refuses every run of the team's Live Exports, scheduled or manual, and leaves their schedules
   * as they are, so sending `false` again resumes them with nothing else to do.
   */
  paused: z.boolean(),
  /** The most records the team's Live Exports may hold together, or null for no limit. */
  recordLimit: z.number().int().nonnegative().nullable(),
  /** The fastest a Live Export of the team may run on a schedule, or null for no limit. */
  fastestCadence: liveExportCadenceSchema.nullable(),
});
export type WhalesyncLiveExportAccess = z.infer<typeof whalesyncLiveExportAccessSchema>;

// ── Subscription payload (the old way to send Live Export access, until DEV-12983 MR 3.2) ────

/** The Whalesync-side subscription status, in the old payload. Only `active` leaves the team's Live Exports running. */
export const whalesyncSubscriptionStatusSchema = z.enum(['none', 'active', 'cancelled', 'expired']);
export type WhalesyncSubscriptionStatus = z.infer<typeof whalesyncSubscriptionStatusSchema>;

/**
 * The subscription state a Whalesync backend from before DEV-12983 MR 3.2 sends, on a session and on
 * `PATCH /subscription`. Scratch maps it onto the team's {@link WhalesyncLiveExportAccess}: paused unless `status` is
 * `active`, with this payload's record limit and cadence. `whalesyncProductType` and `expiresAt` are ignored, and the
 * plan never lapses. Removed once every Whalesync environment sends `liveExportAccess`.
 */
export const whalesyncSubscriptionPayloadSchema = z.object({
  status: whalesyncSubscriptionStatusSchema,
  whalesyncProductType: z.string().optional(),
  liveExportRecordCountLimit: z.number().int().nonnegative().optional(),
  liveExportCadence: liveExportCadenceSchema.optional(),
  /** When the Whalesync subscription expires, as a UTC ISO-8601 timestamp. Ignored: Whalesync pauses a team instead. */
  expiresAt: z.string().datetime().optional(),
});
export type WhalesyncSubscriptionPayload = z.infer<typeof whalesyncSubscriptionPayloadSchema>;

// ── Request DTOs ──────────────────────────────────────────────────────────────

/**
 * Body for `POST /internal/whalesync/sessions`: the Whalesync team (DEV-13019) whose shadow user the session is for.
 * Scratch keeps one shadow user per team and knows nothing about the people in it, so any member's session reaches
 * the same one. Unknown keys are stripped, not rejected, so a Whalesync backend that still sends the acting person's
 * id or email keeps working.
 */
export const whalesyncShadowUserSchema = z.object({
  /** The Whalesync team (`tm_…`). Its shadow user is found by it, or created for it. */
  whalesyncTeamId: z.string().min(1),
  /** A label for a shadow user created for the team: the team's name. Not applied to an existing one. */
  name: z.string().optional(),
  /**
   * The team's Live Export access, applied as `PUT /teams/:whalesyncTeamId/live-export-access` applies it. Wins over
   * `subscription` when both are sent. When both are left out, an existing shadow user's access is left alone, and a
   * new one's Live Exports run with no limits.
   */
  liveExportAccess: whalesyncLiveExportAccessSchema.optional(),
  /** The old way to send the access, from a Whalesync backend before DEV-12983 MR 3.2. */
  subscription: whalesyncSubscriptionPayloadSchema.optional(),
});

export type WhalesyncShadowUserDto = z.infer<typeof whalesyncShadowUserSchema>;

/**
 * Body for `PATCH /internal/whalesync/subscription`, the old way to change a team's Live Export access. Scratch maps
 * `subscription` onto the access (see {@link whalesyncSubscriptionPayloadSchema}). Replaced by
 * `PUT /teams/:whalesyncTeamId/live-export-access`.
 */
export const whalesyncUpdateSubscriptionSchema = z.object({
  /** The team whose plan changed. */
  whalesyncTeamId: z.string().min(1),
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

export interface WhalesyncSetLiveExportAccessResponse {
  /** The team's shadow user, or `null` when the team has none (nothing is created). */
  scratchUserId: string | null;
  /** True when Scratch changed anything; false when the access was already as sent, or the team has no shadow user. */
  updated: boolean;
}

export interface WhalesyncUpdateSubscriptionResponse {
  /** The Scratch user whose subscription was updated, or `null` when the team has no shadow user. */
  scratchUserId: string | null;
  /** True when a Whalesync-plan subscription row was created or updated; false for a no-op. */
  updated: boolean;
  /** The resulting plan type of the user's subscription, or `null` when there is no shadow user / no sub. */
  planType: string | null;
}

/** One of a team's Live Exports (a `ws_export` workbook), as listed for Whalesync's admin dev tools. */
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
  /** Newest first. Empty when the team has no shadow user. Excludes workbooks pending deletion. */
  liveExports: WhalesyncLiveExportSummary[];
}

/**
 * The typed shape stored in `Subscription.metadata` on an organization's `WHALESYNC_PLAN` row: the team's Live Export
 * access. Every field is optional, since rows written before DEV-12983 MR 3.1 carry only some of them. A missing
 * value means no limit, and a team is paused only when `liveExportsPaused` is `true`.
 */
export interface WhalesyncSubscriptionMetadata {
  /** Whether Whalesync has paused the team's Live Exports. */
  liveExportsPaused?: boolean;
  liveExportRecordCountLimit?: number;
  liveExportCadence?: LiveExportCadence;
  /** The Whalesync-side status, on rows written before DEV-12983 MR 3.1. No longer written or read. */
  whalesyncStatus?: WhalesyncSubscriptionStatus;
  /** The Whalesync plan, on rows written before DEV-12983 MR 3.1. No longer written or read. */
  whalesyncProductType?: string;
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
export const liveExportRunFinishedNotificationSchema = z.object({
  /**
   * The Whalesync team (`tm_…`) the Live Export belongs to: the team of the shadow user that owns the workbook
   * (DEV-13019).
   */
  whalesyncTeamId: z.string().min(1),
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
});

export type LiveExportRunFinishedNotificationDto = z.infer<typeof liveExportRunFinishedNotificationSchema>;

/**
 * What Whalesync did with a pushed run. Each one is a handled case answered with a 200, so Scratch counts the run as
 * delivered:
 * - `emailed`: emailed the export's owner.
 * - `muted`: the owner turned Live Export failure emails off.
 * - `throttled`: the owner was already emailed about a Live Export failure within the last day.
 * - `disabled`: failure emails are switched off in that Whalesync environment.
 * - `unknown_user`: Whalesync has no live team by that id.
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
