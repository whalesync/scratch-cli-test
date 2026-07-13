import { User as ClerkUser } from '@clerk/backend';
import { ApiToken } from '@prisma/client';
import { Request as ExpressRequest } from 'express';
import { Socket } from 'socket.io';
import { UserCluster } from 'src/db/cluster-types';

/**
 * Extended user type that adds some additional metadata to the user object to identify the type
 * of authentication used along with packaging in any special clerk data like organizations or name.
 */
export type AuthenticatedUser = UserCluster.User & {
  authType: 'api-token' | 'jwt';
  authSource: 'user' | 'cli' | 'mcp';
  clerkUser?: ClerkUser;
  apiToken?: ApiToken;
  // If the user is being impersonated, this will be the admin who is performing the impersonation
  impersonator?: UserCluster.User;
};

// (Chris) I know there is likely a better Typescript way to do this globally for the server but I didn't have time to figure it out yet
export interface RequestWithUser extends ExpressRequest {
  user: AuthenticatedUser;
}

export interface SocketWithUser extends Socket {
  user: AuthenticatedUser;
}

/**
 * The JWT actor ("act") claim — RFC 8693. Present only when the session is being acted on behalf of
 * someone else, which for us means a Clerk dashboard impersonation: `sub` on the payload remains the
 * impersonated user, while `sub` here is the Clerk user id of the impersonator.
 *
 * Clerk also uses this claim for agent actors, distinguished by `type === 'agent'`; dashboard
 * impersonation leaves `type` unset.
 */
export interface ScratchJwtActorClaim {
  sub: string; // clerk user id of the impersonator
  type?: 'agent';
  [key: string]: unknown;
}

/**
 * Extension to the Clerk JwtPayload type with our custom session fields
 */
export interface ScratchJwtPayload {
  sub: string; // clerk user id
  fullName?: string;
  primaryEmail?: string;
  act?: ScratchJwtActorClaim;
}

/**
 * Connector credentials passed via the X-Scratch-Connector header for CLI requests.
 * This allows CLI tools to provide connection details for data sources.
 */
export interface CliConnectorCredentials {
  service: string;
  params?: Record<string, string>;
}

/**
 * Extended Express Request type for CLI endpoints that may include optional connector credentials
 * parsed from the X-Scratch-Connector header.
 * Note: user can be AuthenticatedUser when API token is valid, or boolean (true) when
 * request is valid but no API token was provided.
 */
export interface CliRequestWithUser extends ExpressRequest {
  connectorCredentials?: CliConnectorCredentials;
  user?: AuthenticatedUser | boolean;
}
