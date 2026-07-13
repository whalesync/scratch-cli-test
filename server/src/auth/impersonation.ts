import { UserCluster } from 'src/db/cluster-types';
import { WSLogger } from 'src/logger';
import { UsersService } from 'src/users/users.service';
import { ScratchJwtPayload } from './types';

/**
 * Resolves the Scratch user behind a session's JWT actor ("act") claim — the admin performing a Clerk
 * dashboard impersonation. Returns undefined when the session is not impersonated.
 *
 * Two deliberate behaviours:
 *
 * - **Never creates a user.** We look the impersonator up with `findByClerkId` rather than
 *   `getOrCreateUserFromClerk`, so an admin who has never used Scratch cannot get a User row minted
 *   into the impersonated user's request.
 * - **Never fails the request.** A lookup error degrades to undefined rather than 401ing an
 *   otherwise-valid session — the authenticated user already resolved fine. But every degraded path
 *   logs, because an impersonated session we cannot attribute is otherwise indistinguishable from an
 *   ordinary one downstream (notably in the audit log).
 */
export async function resolveImpersonatorFromActorClaim(
  jwtPayload: ScratchJwtPayload,
  authenticatedUser: UserCluster.User,
  userService: UsersService,
  logSource: string,
): Promise<UserCluster.User | undefined> {
  const actorClaim = jwtPayload.act;

  if (!actorClaim?.sub) {
    return undefined;
  }

  // Clerk reuses the actor claim for agent actors, marked with `type: 'agent'`. Those are not a human
  // admin impersonating someone, so they must not be reported as an impersonator.
  if (actorClaim.type === 'agent') {
    return undefined;
  }

  const impersonatorClerkId = actorClaim.sub;

  try {
    const impersonator = await userService.findByClerkId(impersonatorClerkId);

    if (!impersonator) {
      WSLogger.warn({
        source: logSource,
        message: 'Impersonated session has no matching Scratch user for the impersonator',
        impersonatorClerkId,
        userId: authenticatedUser.id,
      });
      return undefined;
    }

    return impersonator;
  } catch (error) {
    WSLogger.error({
      source: logSource,
      message: 'Error loading the impersonator for an impersonated session',
      impersonatorClerkId,
      userId: authenticatedUser.id,
      error,
    });
    return undefined;
  }
}
