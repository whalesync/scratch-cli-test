import { FlagDataType } from './types';

/**
 * Configuration and tuning flags that are system-wide and not scoped to a specific user.
 */
export enum SystemFeatureFlag {
  SAMPLE_SYSTEM_FLAG = 'sample_system_flag',
}

/**
 * User-scoped feature flags.
 * These flags are scoped to a specific user and are used to control the behavior of the system for that user.
 * DO NOT USE Persist flag across authentication steps on Posthog flag settings, or they will be hidden from us.
 */
export enum UserFlag {
  DEV_TOOLBOX = 'DEV_TOOLBOX',
  SAMPLE_USER_FLAG = 'sample_user_flag',
  ENABLE_CREATE_BUG_REPORT = 'ENABLE_CREATE_BUG_REPORT',
  SHOW_DESKTOP_FOCUSED_UI = 'SHOW_DESKTOP_FOCUSED_UI',
  SHOW_OPEN_IN_DESKTOP = 'SHOW_OPEN_IN_DESKTOP',
}

/**
 * Enapsulates all the feature flags that are available to the system.
 */
export type AllFeatureFlags = SystemFeatureFlag | UserFlag;

/**
 * The keys and data types for all the flags that are exposed to the client via the /users/current endpoint
 *
 * For a flag to be exposed to the client, it must be added to this object.
 *
 * Make sure to add the flag to the UserExperimentFlags interface in the client types.
 */
export const ClientUserFlags: Record<UserFlag, FlagDataType> = {
  // Special flags based on system flags or user role
  [UserFlag.DEV_TOOLBOX]: 'boolean',
  // User-scoped feature flags
  [UserFlag.SAMPLE_USER_FLAG]: 'boolean',
  [UserFlag.ENABLE_CREATE_BUG_REPORT]: 'boolean',
  [UserFlag.SHOW_DESKTOP_FOCUSED_UI]: 'boolean',
  [UserFlag.SHOW_OPEN_IN_DESKTOP]: 'boolean',
};
