import { ScratchPlanType } from '@spinner/shared-types';

/** User-scoped feature flag settings provided by the server */
export interface UserExperimentFlags {
  DEV_TOOLBOX: boolean;
  ENABLE_CREATE_BUG_REPORT: boolean;
  SHOW_OPEN_IN_DESKTOP: boolean;
  ENABLE_PUBLISH_HISTORY: boolean;
}

export function isExperimentEnabled(experiment: keyof UserExperimentFlags, user: User | null): boolean {
  return user?.experimentalFlags?.[experiment] === true;
}

/** Mirrors the server's User entity returned by /users/current. */
export interface User {
  id: string;
  clerkId: string;
  createdAt: string;
  updatedAt: string;
  websocketToken?: string;
  apiToken?: string;
  isAdmin: boolean;
  subscription?: SubscriptionInfo;
  experimentalFlags?: UserExperimentFlags;
  name?: string;
  email?: string;
  organization?: Organization;
  settings?: Record<string, string | number | boolean>;
  lastWorkbookId?: string;
  waitlistApproved: boolean;
  serverBuildVersion?: string;
}

export interface SubscriptionInfo {
  status: 'valid' | 'expired' | 'payment_failed' | 'none';
  planDisplayName: string;
  planType: ScratchPlanType;
  costUSD: number;
  daysRemaining: number;
  isTrial: boolean;
  isCancelled: boolean;
  canManageSubscription: boolean;
  ownerId: string;
}

export interface Organization {
  id: string;
  clerkId: string;
  name: string;
}

export type UserSettingValue = string | number | boolean;

export enum UserSetting {
  DEFAULT_LLM_MODEL = 'default_llm_model',
}
