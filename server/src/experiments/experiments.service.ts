import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { User, UserRole } from '@prisma/client';
import { PostHog } from 'posthog-node';
import { ScratchConfigService } from '../config/scratch-config.service';
import { WSLogger } from '../logger';
import { AllFeatureFlags, ClientUserFlags, SystemFeatureFlag, UserFlag } from './flags';
import { ExperimentFlagVariantValue, FlagDataType, JsonValue } from './types';

export type UserFlagValues = Partial<Record<UserFlag, ExperimentFlagVariantValue>>;

// Most feature flags just need to target a specific user by their ID
export type PartialUser = Pick<User, 'id' | 'role'>;

@Injectable()
export class ExperimentsService implements OnModuleDestroy {
  private posthog: PostHog | undefined;

  constructor(private readonly config: ScratchConfigService) {
    const apiKey = config.getPostHogApiKey();
    const host = config.getPostHogHost();
    const personalApiKey = config.getPosthogFeatureFlagApiKey();

    if (apiKey && personalApiKey) {
      this.posthog = new PostHog(apiKey, {
        host: host ?? 'https://us.i.posthog.com',
        personalApiKey,
      });

      WSLogger.info({
        source: ExperimentsService.name,
        message: 'PostHog feature flags are enabled',
      });
    } else {
      WSLogger.warn({
        source: ExperimentsService.name,
        message: 'PostHog feature flags are disabled — returning default values',
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.posthog) {
      await this.posthog.shutdown();
    }
  }

  /**
   * Evaluates all the client-facing feature flags for a given user and provides them as a single object.
   * @param user - The user to evaluate the feature flags for
   * @returns An object with the flag values for the user
   */
  public async resolveClientFeatureFlagsForUser(user: User): Promise<UserFlagValues> {
    const flagValues: UserFlagValues = {};

    // Evaluate each client-facing feature flag, along with some special ones that are not user-scoped
    for (const [key, dataType] of Object.entries(ClientUserFlags) as [UserFlag, FlagDataType][]) {
      if (key === UserFlag.DEV_TOOLBOX) {
        // Based on the user's role, set the flag value
        flagValues[key] = user.role === UserRole.ADMIN ? true : false;
      } else if (key === UserFlag.ENABLE_SCRATCH_FOLDERS) {
        // DEV-10424: enabled in every non-production environment so it stays on
        // for local/test dogfooding; in production it falls back to a PostHog
        // flag (default false) so it can be switched on later without a redeploy.
        flagValues[key] = this.config.isProductionEnvironment() ? await this.getBooleanFlag(key, false, user) : true;
      } else if (dataType === 'boolean') {
        flagValues[key] = await this.getBooleanFlag(key, false, user);
      } else if (dataType === 'string') {
        flagValues[key] = await this.getStringFlag(key, '', user);
      } else if (dataType === 'number') {
        flagValues[key] = await this.getNumberFlag(key, 0, user);
      } else if (dataType === 'array') {
        flagValues[key] = await this.getJsonFlag(key, [], user);
      }
    }
    return flagValues;
  }

  /**
   * Gets a boolean flag value for a given feature flag
   * @param flag - The feature flag to get the value for
   * @param defaultValue - The default value to return if the flag is not set
   * @param user - Optional. The user / userId to get the flag value for
   * @returns The boolean flag value
   */
  public async getBooleanFlag(flag: AllFeatureFlags, defaultValue: boolean, user?: PartialUser): Promise<boolean> {
    if (flag in UserFlag && !user) {
      throw new Error('User ID must be provided when accessing a User-scoped feature flag');
    }
    if (!this.posthog) {
      return defaultValue;
    }
    try {
      const result = await this.posthog.isFeatureEnabled(flag, user?.id ?? '');
      return result ?? defaultValue;
    } catch (err) {
      WSLogger.warn({
        source: ExperimentsService.name,
        message: `Failed to evaluate boolean flag "${flag}"`,
        error: err,
      });
      return defaultValue;
    }
  }

  /**
   * Gets a boolean SYSTEM flag value scoped to an organization. Used for
   * org-level kill switches / staged rollouts — e.g. the DEV-10316
   * `desktop_dirty_gate_enabled` gate. The organization id is used as the
   * PostHog distinct id, so a flag configured with a percentage rollout or a
   * `distinct_id` release condition evaluates deterministically per org; we
   * can enable specific orgs first (e.g. one customer) without shipping a new
   * desktop/CLI build. (This codebase does not register PostHog group
   * analytics, so org targeting rides on the distinct id rather than a group
   * context.) Returns `defaultValue` when PostHog is disabled or the lookup
   * throws — callers that need fail-closed behavior must guard the protected
   * operation separately (the dirty gate does: it fail-closes on the git check
   * itself, not on this flag read).
   * @param flag - The system feature flag to evaluate
   * @param defaultValue - Returned if PostHog is disabled or the lookup fails
   * @param organizationId - The organization to scope the evaluation to
   */
  public async getBooleanFlagForOrg(
    flag: SystemFeatureFlag,
    defaultValue: boolean,
    organizationId: string,
  ): Promise<boolean> {
    if (!this.posthog) {
      return defaultValue;
    }
    try {
      const result = await this.posthog.isFeatureEnabled(flag, organizationId);
      return result ?? defaultValue;
    } catch (err) {
      WSLogger.warn({
        source: ExperimentsService.name,
        message: `Failed to evaluate org-scoped boolean flag "${flag}" for org ${organizationId}`,
        error: err,
      });
      return defaultValue;
    }
  }

  /**
   * Gets a string flag value for a given feature flag
   * This works differently for different types of feature flages:
   *   - Multi-varient flags will return the variant name
   *   - Remote config flags will return the string value of the flag
   * @param flag - The feature flag to get the value for
   * @param defaultValue - The default value to return if the flag is not set
   * @param user - Optional. The user / userId to get the flag value for
   * @returns The string flag value
   */
  public async getStringFlag(flag: AllFeatureFlags, defaultValue: string, user?: PartialUser): Promise<string> {
    if (flag in UserFlag && !user) {
      throw new Error('User ID must be provided when accessing a User-scoped feature flag');
    }
    if (!this.posthog) {
      return defaultValue;
    }
    try {
      const result = await this.posthog.getFeatureFlag(flag, user?.id ?? '');
      return typeof result === 'string' ? result : defaultValue;
    } catch (err) {
      WSLogger.warn({
        source: ExperimentsService.name,
        message: `Failed to evaluate string flag "${flag}"`,
        error: err,
      });
      return defaultValue;
    }
  }

  /**
   * Gets a number flag value for a given feature flag
   * This only works for Feature Flags that serve a Remote config (single payload)
   * @param flag - The feature flag to get the value for
   * @param defaultValue - The default value to return if the flag is not set
   * @param user - Optional. The user / userId to get the flag value for
   * @returns The number flag value
   */
  public async getNumberFlag(flag: AllFeatureFlags, defaultValue: number, user?: PartialUser): Promise<number> {
    if (flag in UserFlag && !user) {
      throw new Error('User ID must be provided when accessing a User-scoped feature flag');
    }
    if (!this.posthog) {
      return defaultValue;
    }
    try {
      const result = await this.posthog.getFeatureFlag(flag, user?.id ?? '');
      return typeof result === 'number' ? result : defaultValue;
    } catch (err) {
      WSLogger.warn({
        source: ExperimentsService.name,
        message: `Failed to evaluate number flag "${flag}"`,
        error: err,
      });
      return defaultValue;
    }
  }

  /**
   * Convenience check for the ENABLE_GENERIC_CONNECTOR per-user gate.
   * Returns true only when PostHog explicitly enables the GENERIC_API
   * connector for the given user via a matching release condition.
   * Fail-closed: missing user id, missing PostHog config, evaluation
   * failures, and unmatched users all resolve to `false` (connector
   * disabled) so the kill switch is reliable even during a PostHog outage.
   */
  public async isGenericConnectorEnabledForUser(userId: string): Promise<boolean> {
    if (!this.posthog || !userId) {
      return false;
    }
    try {
      const result = await this.posthog.isFeatureEnabled(UserFlag.ENABLE_GENERIC_CONNECTOR, userId);
      return result === true;
    } catch (err) {
      WSLogger.warn({
        source: ExperimentsService.name,
        message: `Failed to evaluate ENABLE_GENERIC_CONNECTOR for user ${userId}`,
        error: err,
      });
      return false;
    }
  }

  /**
   * Gets a JSON payload for a given feature flag. JSON and Array types are the same for the client.
   * NOTE, in Posthog the payload is separate from the feature flag value. getStringFlag() will return the variant name, while getJsonFlag() will return the payload.
   * @param flag - The feature flag to get the value for
   * @param defaultValue - The default value to return if the flag is not set
   * @param user - Optional. The user / userId to get the flag value for
   * @returns The JSON flag value
   */
  public async getJsonFlag(flag: AllFeatureFlags, defaultValue: JsonValue, user?: PartialUser): Promise<JsonValue> {
    if (flag in UserFlag && !user) {
      throw new Error('User ID must be provided when accessing a User-scoped feature flag');
    }
    if (!this.posthog) {
      return defaultValue;
    }
    try {
      const result = await this.posthog.getFeatureFlagPayload(flag, user?.id ?? '');
      return (result as JsonValue) ?? defaultValue;
    } catch (err) {
      WSLogger.warn({
        source: ExperimentsService.name,
        message: `Failed to evaluate JSON flag "${flag}"`,
        error: err,
      });
      return defaultValue;
    }
  }
}
