import { FlagDataType } from './types';

/**
 * Configuration and tuning flags that are system-wide and not scoped to a specific user.
 * DO NOT USE Persist flag across authentication steps on Posthog flag settings, or they will be hidden from us.
 * Use All Caps for flag names separated by underscores.
 */
export enum SystemFeatureFlag {
  SAMPLE_SYSTEM_FLAG = 'sample_system_flag',
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
   * Kill switch for incremental polling. When false, the pull job forces every
   * folder to a full pull regardless of `data.pullMode`. When true, the
   * standard per-folder resolution applies (capability check, bootstrap).
   * Checked server-side only — not exposed to the client via
   * `ClientUserFlags`.
   */
  INCREMENTAL_POLLING_ENABLED = 'INCREMENTAL_POLLING_ENABLED',
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
  [UserFlag.INCREMENTAL_POLLING_ENABLED]: 'boolean',
};
