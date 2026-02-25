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
  CONNECTOR_LIST = 'CONNECTOR_LIST',
  ENABLE_TOKEN_LIMIT_WARNINGS = 'ENABLE_TOKEN_LIMIT_WARNINGS',
  ENABLE_WEBFLOW_OAUTH = 'ENABLE_WEBFLOW_OAUTH',
  ENABLE_SHOPIFY_OAUTH = 'ENABLE_SHOPIFY_OAUTH',
  ENABLE_CREATE_BUG_REPORT = 'ENABLE_CREATE_BUG_REPORT',
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
  [UserFlag.CONNECTOR_LIST]: 'array',
  // User-scoped feature flags
  [UserFlag.SAMPLE_USER_FLAG]: 'boolean',
  [UserFlag.ENABLE_TOKEN_LIMIT_WARNINGS]: 'boolean',
  [UserFlag.ENABLE_WEBFLOW_OAUTH]: 'boolean',
  [UserFlag.ENABLE_SHOPIFY_OAUTH]: 'boolean',
  [UserFlag.ENABLE_CREATE_BUG_REPORT]: 'boolean',
};
