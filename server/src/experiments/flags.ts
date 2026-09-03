import { FlagDataType } from './types';

/**
 * Configuration and tuning flags that are system-wide and not scoped to a specific user.
 * DO NOT USE Persist flag across authentication steps on Posthog flag settings, or they will be hidden from us.
 * Use ALL CAPS for both enum and flag names separated by underscores.
 */
export enum SystemFeatureFlag {
  /**
   * DEV-10316 kill switch. When enabled for an organization, the
   * `/upload-patch/commit` endpoint refuses a desktop/CLI publish whose
   * connection still has unpublished changes on the server (the dirty gate).
   * Break-glass, not a neutral toggle: turning it OFF restores the original
   * over-publish behavior. Evaluated per-org via `getBooleanFlagForOrg`.
   */
  DESKTOP_DIRTY_GATE_ENABLED = 'desktop_dirty_gate_enabled',
  /**
   * DEV-10535 gate for auto-starting a Pro trial subscription when a new user
   * signs up. When enabled for the newly-created user's organization, native
   * (Clerk) sign-up starts a 14-day Pro trial via
   * `StripePaymentService.createTrialSubscription` (see
   * `UsersService.maybeStartProTrialForNewUser`). When FALSE (default), no
   * subscription is created at sign-up and the user stays on the Free plan.
   * Fail-closed: default false
   */
  AUTO_TRIAL_SUBSCRIPTION_ON_SIGNUP = 'AUTO_TRIAL_SUBSCRIPTION_ON_SIGNUP',
  /** DEV-10573 gate for trial reminder emails (3-day reminder + post-expiry notice). Default false. */
  TRIAL_REMINDER_EMAILS = 'TRIAL_REMINDER_EMAILS',
  /**
   * DEV-11400 opt-in gate + kill switch for the subscription-enforcement cron
   * (`SubscriptionEnforcementService`, every 15 min). When enabled, the cron disables
   * all scheduled actions for organizations whose subscription lapsed; flip it off to
   * halt enforcement without a redeploy. Fail-closed: evaluated with no user via
   * `getBooleanFlag(..., false)`, so it is OFF by default and an absent flag or a
   * PostHog outage leaves enforcement off (it never blindly quiesces schedules). Turn
   * it on with a 100%-rollout release condition when ready to enforce.
   */
  SUBSCRIPTION_ENFORCEMENT_ENABLED = 'SUBSCRIPTION_ENFORCEMENT_ENABLED',
}

/**
 * User-scoped feature flags.
 * These flags are scoped to a specific user and are used to control the behavior of the system for that user.
 * DO NOT USE Persist flag across authentication steps on Posthog flag settings, or they will be hidden from us.
 * Use All Caps for flag names separated by underscores.
 */
export enum UserFlag {
  DEV_TOOLBOX = 'DEV_TOOLBOX',
  ENABLE_CREATE_BUG_REPORT = 'ENABLE_CREATE_BUG_REPORT',
  SHOW_OPEN_IN_DESKTOP = 'SHOW_OPEN_IN_DESKTOP',
  /**
   * Per-user gate for the GENERIC_API connector. When TRUE for a user:
   *   - the "Bring your own API" entry point is shown in the create-connection modal,
   *   - creating a new GENERIC_API connector account succeeds,
   *   - all operations on existing GENERIC_API connector accounts succeed (update,
   *     remove, reset, test, list/search/schema, quota, probe, reprobe).
   * Default (flag false / unmatched / PostHog unreachable): connector is disabled
   * for that user. Fail-closed — enable only via an explicit release condition.
   */
  ENABLE_GENERIC_CONNECTOR = 'ENABLE_GENERIC_CONNECTOR',
  /**
   * Per-user gate for the Publish History UI surface. When TRUE for a user, a
   * "Publish History" sub-tab appears under Runs in the workbook web app.
   * Client-only gate today — the underlying publish-plan data is already
   * available to anyone with workbook access.
   */
  ENABLE_PUBLISH_HISTORY = 'ENABLE_PUBLISH_HISTORY',
  /**
   * DEV-10424 gate for the standalone "Scratch" (connector-less) files & folders
   * feature — the "Scratch" group in the workbook sidebar plus its create-folder /
   * create-file / browse surfaces in both the web client and the desktop app.
   * Resolved from the server ENVIRONMENT rather than per-user targeting (see
   * `ExperimentsService.resolveClientFeatureFlagsForUser`): TRUE in every
   * non-production environment (development / test / staging) so it stays on for
   * local and test dogfooding, and in production it falls back to a PostHog flag
   * that defaults to FALSE — so the feature is off for prod users today but can be
   * switched on later without a redeploy. Client-only gate: the underlying scratch
   * data/endpoints remain available; only the UI surfaces are hidden when false.
   */
  ENABLE_SCRATCH_FOLDERS = 'ENABLE_SCRATCH_FOLDERS',
  /**
   * Per-user gate for the new "use connector's returned row as the
   * post-publish blob" path. When TRUE, the publish service uses the
   * `ConnectorFile[]` returned by `Connector.updateRecords` to build the
   * git commit on `main`, capturing trigger-set timestamps, normalized
   * values, computed columns, and native PK types as Postgres/the
   * connector actually persisted them. When FALSE (default), the
   * pre-existing sent-payload behavior is preserved. Checked server-side
   * only — not exposed to the client. See
   * `docs/plans/2026-05-29-publish-pk-stringification-bug/2026-05-29-publish-pk-stringification-bug.md` for the
   * broader fix plan.
   */
  UPDATE_RECORDS_RETURNS_REMOTE_DATA = 'UPDATE_RECORDS_RETURNS_REMOTE_DATA',
  /**
   * DEV-10298 rollout gate for Affinity connector writes. The Affinity connector
   * implements full create/update/delete, but publishing to Affinity is being
   * productionized — so writes are refused for everyone except users on this
   * flag. When TRUE for the publishing user, Affinity create/update/delete/
   * backfill proceed; when FALSE (default), each service-mutating publish batch
   * throws a read-only error (the pre-write-codepath behavior), surfaced per
   * record in the review UI. Fail-closed: default false, unmatched users and a
   * PostHog outage both yield false. Evaluated inside the Affinity connector via
   * the host-provided `ConnectorFactoryContext.isFeatureEnabled` capability,
   * which `ConnectorsService` binds to the publishing user (`plan.userId`).
   * Checked only in the connector write path, so it is NOT exposed to the client.
   */
  ENABLE_AFFINITY_WRITE = 'ENABLE_AFFINITY_WRITE',
  /**
   * DEV-10617 per-user gate for the redesigned desktop review surface ("review
   * surface v2" — Client-only UI
   */
  DESKTOP_REVIEW_SURFACE_V2 = 'DESKTOP_REVIEW_SURFACE_V2',
  /**
   * DEV-10200 migration gate for HubSpot association writes. HubSpot retires the
   * v4 APIs on 2027-03-30; the replacement is the date-versioned `2026-03` API.
   * When TRUE for the publishing user, the HubSpot connector writes associations
   * through the `2026-03` URLs; when FALSE (default), it keeps using v4. The two
   * endpoints are 1:1 (same default-association create, same delete-all
   * semantics), so this flag exists to catch HubSpot-side behavior differences
   * during rollout, not to gate a feature. Fail-closed to v4: unmatched users
   * and a PostHog outage both keep the old URLs. Evaluated inside the HubSpot
   * connector via `ConnectorFactoryContext.isFeatureEnabled`; server-only, so
   * NOT in `ClientUserFlags`. Delete after the migration bakes in.
   */
  HUBSPOT_ASSOCIATIONS_API_2026_03 = 'HUBSPOT_ASSOCIATIONS_API_2026_03',
  /**
   * DEV-10200 rollout gate for batched HubSpot publishing. When TRUE for the
   * publishing user, the HubSpot connector publishes up to 10 records of one
   * object type per API call (`batch/create` / `batch/update`), then writes
   * all their association links in one call per association type through the
   * 2026-03 batch endpoints (needs `HUBSPOT_ASSOCIATIONS_API_2026_03` too;
   * with v4 still selected the links fall back to one call per pair). It also
   * stops swallowing association-write failures: a rejected link fails the
   * record's publish with HubSpot's reason instead of logging a warning —
   * expect visibly higher HubSpot publish error rates as hidden failures
   * surface. Quotes never batch (their recall window is per record). When
   * FALSE (default), every record publishes one call at a time as before.
   * Resolved once per connector instance at construction (the batch size is
   * a synchronous per-operation answer). Fail-closed. Server-only, so NOT in
   * `ClientUserFlags`. Delete after the batching bakes in.
   */
  HUBSPOT_BATCH_PUBLISH = 'HUBSPOT_BATCH_PUBLISH',
  /**
   * DEV-10735 minimum supported desktop-app version. The flag's PostHog JSON
   * payload is a semver string (e.g. `"0.2.0"`); when set, the desktop app locks
   * its UI and forces an upgrade for any build older than that version. Evaluated
   * per-user (via `ExperimentsService.getMinimumSupportedDesktopVersion`) so a new
   * minimum can be rolled out to a subset of users — e.g. force-deprecating
   * versions older than a week when reworking OAuth params. Surfaced on
   * `/users/current` as `minimumDesktopClientVersion`, NOT in `experimentalFlags`,
   * so it is intentionally absent from `ClientUserFlags`. Fail-open: an empty
   * payload, a PostHog outage, or a non-string payload all yield "no minimum" so a
   * flag-service blip never locks users out.
   */
  MINIMUM_SUPPORTED_DESKTOP_VERSION = 'MINIMUM_SUPPORTED_DESKTOP_VERSION',
  /**
   * DEV-10556 rollout gate for field-value canonicalizers. A canonicalizer
   * teaches the sync that two differently-shaped values mean the same thing to
   * the destination service (e.g. Notion returns a decorated copy of the title
   * we wrote). Without them, a sync sees those values as different, rewrites
   * every record, and re-publishes unchanged data on every Live Export run.
   * See CONNECTOR_GUIDE → "Field Value Canonicalizers".
   *
   * When TRUE for the acting user: during a sync, a field whose new value is
   * canonically equal to the stored value is left untouched
   * (`SyncService.syncTableMapping`). When FALSE (default): values are
   * compared exactly as before DEV-10556.
   *
   * This flag only affects the sync. The publish-plan build
   * (`computeChangedFields` in `PublishPlanBuildService`) never uses
   * canonicalizers, so a local edit always publishes. The read-only publish
   * diff view (`PublishPlanDiffService`) renders canonical forms for display
   * regardless of this flag; nothing it returns feeds a publish.
   *
   * Gates the canonicalizers of EVERY connector that registers a
   * `resolveFieldValueCanonicalizer` hook — Notion, Airtable, Postgres and
   * Supabase today (DEV-11420 registered the last three). The name is
   * historical: it was coined when only Notion registered one, and the PostHog
   * flag key is kept so existing per-user rollouts carry over unchanged.
   *
   * Fail-closed: defaults to false; an unmatched user or a PostHog outage
   * also yields false. Checked server-side only — not exposed to the client.
   */
  ENABLE_NOTION_FIELD_VALUE_CANONICALIZERS = 'ENABLE_NOTION_FIELD_VALUE_CANONICALIZERS',
  /**
   * DEV-11069 experiment. Lets a Live Export pull only new and changed records
   * from its destination, instead of every record on every run.
   *
   * By default, every pull in a Live Export run is a full pull. A full pull is
   * the only kind that notices when a record was deleted or archived on the
   * destination. An incremental pull skips that check.
   *
   * Turn the flag on for a user. Then set its JSON payload to a list of
   * connector names. Only those connectors are affected. Examples:
   * `["NOTION"]`, `["NOTION", "AIRTABLE"]`, or `["*"]` for all connectors.
   * Names are not case-sensitive. An empty list or a payload of any other
   * shape means no connector is affected, and the server logs a warning. See
   * `live-export-incremental-destination-pull.ts`.
   *
   * When the flag is on for the user: each destination whose connector is in
   * the list pulls incrementally. The source and all other destinations still
   * pull in full. The first run after turning it on is still a full pull.
   * Deleted or archived destination records are not noticed until the next
   * full pull.
   *
   * When the flag is off: every pull is a full pull. This is the default.
   *
   * The flag is checked when the user saves the Live Export, not when it runs.
   * The choice is written into the routine file. To change it, save the
   * Live Export again. On a local server, set
   * `FEATURE_FLAG_OVERRIDES_FOR_LOCAL_DEV=<flag>=true` and
   * `FEATURE_FLAG_PAYLOAD_OVERRIDES_FOR_LOCAL_DEV={"<flag>":["NOTION"]}`.
   *
   * If the user is not matched, or PostHog is down, the flag counts as off.
   * Server-only. Not sent to the client.
   */
  ENABLE_LIVE_EXPORT_INCREMENTAL_DESTINATION_PULL = 'ENABLE_LIVE_EXPORT_INCREMENTAL_DESTINATION_PULL',
}

/**
 * Enapsulates all the feature flags that are available to the system.
 */
export type AllFeatureFlags = SystemFeatureFlag | UserFlag;

/**
 * The keys and data types for all the flags that are exposed to the client via the /users/current endpoint.
 *
 * For a flag to be exposed to the client, it must be added to this object. Server-only flags (e.g. kill
 * switches checked exclusively in worker code) should NOT be listed here — the `Partial` lets us omit them.
 *
 * Make sure to add the flag to the UserExperimentFlags interface in the client types.
 */
export const ClientUserFlags: Partial<Record<UserFlag, FlagDataType>> = {
  // Special flags based on system flags or user role
  [UserFlag.DEV_TOOLBOX]: 'boolean',
  // User-scoped feature flags
  [UserFlag.ENABLE_CREATE_BUG_REPORT]: 'boolean',
  [UserFlag.SHOW_OPEN_IN_DESKTOP]: 'boolean',
  [UserFlag.ENABLE_GENERIC_CONNECTOR]: 'boolean',
  [UserFlag.ENABLE_PUBLISH_HISTORY]: 'boolean',
  [UserFlag.ENABLE_SCRATCH_FOLDERS]: 'boolean',
  [UserFlag.DESKTOP_REVIEW_SURFACE_V2]: 'boolean',
};
