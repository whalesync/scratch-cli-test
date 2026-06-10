import type { User, UserExperimentFlags } from '@spinner/shared-types';

// User, UserExperimentFlags, SubscriptionInfo, Organization are the shared contract —
// re-exported here so existing '../types/user' importers keep working.
export type { Organization, SubscriptionInfo, User, UserExperimentFlags } from '@spinner/shared-types';

export function isExperimentEnabled(experiment: keyof UserExperimentFlags, user: User | null): boolean {
  return user?.experimentalFlags?.[experiment] === true;
}

export type UserSettingValue = string | number | boolean;

export enum UserSetting {
  DEFAULT_LLM_MODEL = 'default_llm_model',
}
