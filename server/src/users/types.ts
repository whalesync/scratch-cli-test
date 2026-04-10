import { UserRole } from '@prisma/client';
import { ScratchPlanType, SubscriptionId, WorkbookId, WorkspacePermissionId } from '@spinner/shared-types';
import { UserCluster } from 'src/db/cluster-types';
import { WSLogger } from 'src/logger';
import { getLastestExpiringSubscription, isSubscriptionExpired } from 'src/payment/helpers';
import { getPlanTypeFromString } from 'src/payment/plans';

/**
 * Defines the subscription status of the Actor for use to validate actions
 */
export interface SubscriptionStatus {
  status: 'active' | 'expired' | 'payment_failed';
  planType: ScratchPlanType;
  subscriptionId?: SubscriptionId;
}

export type WorkspacePermissionRole = 'editor';

export interface WorkspacePermission {
  id: WorkspacePermissionId;
  workbookId: WorkbookId;
  role: WorkspacePermissionRole;
}

export type AuthSource = 'user' | 'cli' | 'mcp';

/**
 *
 * An Actor defines the user that is performing and action and the organization they are acting on behalf
 * of, including the subscription status of the account. Actors are meant to be passed to services to identify the caller.
 */
export interface Actor {
  userId: string;
  organizationId: string;
  subscriptionStatus?: SubscriptionStatus;
  authSource?: AuthSource;
  isAdmin?: boolean;
  workspacePermissions?: WorkspacePermission[];
}

// The system actor is used for actions that are not performed by a user, such as system jobs or cron jobs
export const SYSTEM_ACTOR: Actor = {
  userId: 'system',
  organizationId: 'system',
  workspacePermissions: [],
};

export function isSystemActor(actor: Actor): boolean {
  return actor.userId === SYSTEM_ACTOR.userId;
}

export function userToActor(user: UserCluster.User): Actor {
  if (!user.organizationId) {
    WSLogger.error({
      source: 'users.userToActor',
      message: 'User does not have an organization id',
      userId: user.id,
    });
  }

  let subscriptionStatus: SubscriptionStatus | undefined;
  if (user.organization && user.organization.subscriptions.length > 0) {
    const latestSubscription = getLastestExpiringSubscription(user.organization.subscriptions);
    if (latestSubscription) {
      const planType = getPlanTypeFromString(latestSubscription.planType);
      if (planType) {
        subscriptionStatus = {
          status: isSubscriptionExpired(latestSubscription) ? 'expired' : 'active',
          planType,
          subscriptionId: latestSubscription.id as SubscriptionId,
        };
      } else {
        WSLogger.error({
          source: 'users.userToActor',
          message: 'Unable to extract product type from subscription',
          userId: user.id,
          planType: latestSubscription.planType,
          subscriptionId: latestSubscription.id,
        });
      }
    }
  }

  if (!subscriptionStatus) {
    // Fallback to the Free Plan
    subscriptionStatus = {
      status: 'active',
      planType: ScratchPlanType.FREE_PLAN,
    };
  }

  let authSource: AuthSource = 'user';
  if ('authSource' in user && typeof user.authSource === 'string') {
    authSource = user.authSource as AuthSource;
  }

  // Gather workspace permissions for the user
  let workspacePermissions: WorkspacePermission[] | undefined;
  if (user.workspacePermissions) {
    workspacePermissions = user.workspacePermissions.map((wp) => ({
      id: wp.id as WorkspacePermissionId,
      workbookId: wp.workbookId as WorkbookId,
      role: wp.role as WorkspacePermissionRole,
    }));
  }

  return {
    userId: user.id,
    organizationId: user.organizationId ?? '<empty org id>',
    subscriptionStatus,
    authSource,
    isAdmin: user.role === UserRole.ADMIN,
    workspacePermissions,
  };
}

export interface UserSettings {
  [key: string]: string | number | boolean;
}
