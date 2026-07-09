import { FlagDataType } from './types';

/**
 * Configuration and tuning flags that are system-wide and not scoped to a specific user.
 * DO NOT USE Persist flag across authentication steps on Posthog flag settings, or they will be hidden from us.
 * Use ALL CAPS for both enum and flag names separated by underscores.
 */
export enum SystemFeatureFlag {
  SAMPLE_SYSTEM_FLAG = 'sample_system_flag',
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
