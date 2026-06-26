import { Subscription, UserRole } from '@prisma/client';
import {
  BillableActions,
  ScratchPlanType,
  SubscriptionInfo,
  TokenType,
  WorkbookId,
  WorkspacePermissionId,
} from '@spinner/shared-types';
import { UserCluster } from 'src/db/cluster-types';
import { UserFlagValues } from 'src/experiments/experiments.service';
import { WSLogger } from 'src/logger';
import { SubscriptionPlanFeaturesEntity } from 'src/payment/entities/subscription-plan';
import { getLastestExpiringSubscription } from 'src/payment/helpers';
import { getFreePlan, getPlan, getPlanTypeFromString } from 'src/payment/plans';
import { BUILD_VERSION } from 'src/version';
import { WorkspacePermission, WorkspacePermissionRole } from '../types';
import { Organization } from './organization.entity';

export type { SubscriptionInfo } from '@spinner/shared-types';

export class User {
  createdAt: Date;
  updatedAt: Date;
  clerkId: string | null;
  whalesyncUserId: string | null;
  stripeCustomerId: string | null;
  isAdmin: boolean;
  id: string;
  name?: string;
  email?: string;

  // The token for the client to use for websockets when connecting to the Scratch API
  websocketToken?: string;

  // The user's API token for external API access (CLI, integrations, etc.)
  apiToken?: string;

  subscription?: SubscriptionInfo;

  experimentalFlags?: UserFlagValues;

  organization?: Organization;

  settings?: Record<string, string | number | boolean>;

  // The ID of the last workbook the user was viewing (for quick redirect on home page)
  lastWorkbookId?: string;

  waitlistApproved: boolean;

  serverBuildVersion: string;

  workspacePermissions?: WorkspacePermission[];

  constructor(user: UserCluster.User, experiments?: UserFlagValues, billableActions?: BillableActions) {
    this.id = user.id;
    this.createdAt = user.createdAt;
    this.updatedAt = user.updatedAt;
    this.clerkId = user.clerkId;
    this.whalesyncUserId = user.whalesyncUserId;
    this.isAdmin = user.role === UserRole.ADMIN;
    this.name = user.name || undefined;
    this.email = user.email || undefined;
    this.stripeCustomerId = user.stripeCustomerId || null;
    this.lastWorkbookId = user.lastWorkbookId || undefined;
    this.waitlistApproved = user.waitlistApproved;

    if (user.apiTokens) {
      this.websocketToken = findValidToken(user, TokenType.WEBSOCKET);
      this.apiToken = findValidToken(user, TokenType.USER);
    }

    this.experimentalFlags = experiments;
    this.subscription = toSubscriptionInfo(
      user.id,
      user.organization?.subscriptions ?? [],
      billableActions ?? { monthlyPublishCount: 0 },
    );
    this.organization = user.organization ? new Organization(user.organization) : undefined;
    this.settings = user.settings as Record<string, string | number | boolean>;
    this.serverBuildVersion = BUILD_VERSION;

    this.workspacePermissions = user.workspacePermissions?.map((wp) => ({
      id: wp.id as WorkspacePermissionId,
      workbookId: wp.workbookId as WorkbookId,
      role: wp.role as WorkspacePermissionRole,
    }));
  }
}

export function findValidToken(user: UserCluster.User, type: TokenType): string | undefined {
  return user.apiTokens.find((token) => token.expiresAt > new Date() && token.type === (type as string))?.token;
}

function buildFreePlanSubscriptionInfo(userId: string, billableActions: BillableActions): SubscriptionInfo {
  const plan = getFreePlan();
  return {
    status: 'valid',
    planDisplayName: plan.displayName,
    planType: plan.planType,
    costUSD: plan.costUSD,
    daysRemaining: 0,
    isTrial: false,
    isCancelled: false,
    canManageSubscription: true,
    ownerId: userId,
    features: new SubscriptionPlanFeaturesEntity(plan.features),
    billableActions,
  };
}

function toSubscriptionInfo(
  userId: string,
  subscriptions: Subscription[],
  billableActions: BillableActions,
): SubscriptionInfo | undefined {
  const latestSubscription = getLastestExpiringSubscription(subscriptions);
  if (!latestSubscription) {
    // If the user has no subscription at all, use the Free Plan
    return buildFreePlanSubscriptionInfo(userId, billableActions);
  }

  const planType = getPlanTypeFromString(latestSubscription.planType);

  if (!planType) {
    WSLogger.error({
      source: 'users.toSubscriptionInfo',
      message: 'Unable to extract plan type from existing subscription',
      userId: userId,
      planType: latestSubscription.planType,
      subscriptionId: latestSubscription.id,
    });
    return buildFreePlanSubscriptionInfo(userId, billableActions);
  }

  const plan = getPlan(planType);

  if (!plan) {
    WSLogger.error({
      source: 'users.toSubscriptionInfo',
      message: 'Unable to find plan for plan type',
      userId: userId,
      planType: planType,
      subscriptionId: latestSubscription.id,
    });
    return buildFreePlanSubscriptionInfo(userId, billableActions);
  }

  /* How much longer the subscription is valid in days. A negative number respresents how long since the 
  subscription expired */
  const daysRemaining = Math.ceil(
    (latestSubscription.expiration.getTime() - new Date().getTime()) / (1000 * 60 * 60 * 24),
  );
  let status: SubscriptionInfo['status'] = 'valid';
  if (latestSubscription.expiration < new Date()) {
    status = 'expired';
  }
  if (latestSubscription.lastInvoicePaid === false) {
    status = 'payment_failed';
  }

  return {
    status,
    planDisplayName: plan.displayName,
    planType: planType,
    costUSD: plan.costUSD,
    daysRemaining,
    isTrial: latestSubscription.stripeStatus === 'trialing',
    isCancelled: latestSubscription.cancelAt !== null, // if cancelled the days remaining will also represent when the subscription ends
    // The Whalesync plan has no real Stripe subscription behind it, so there is nothing to manage in the
    // billing portal — never offer "manage" for it. The plan name/cost still render, so it stays visible.
    canManageSubscription: planType !== ScratchPlanType.WHALESYNC_PLAN && latestSubscription.userId === userId,
    ownerId: latestSubscription.userId,
    features: new SubscriptionPlanFeaturesEntity(plan.features),
    billableActions,
  };
}
