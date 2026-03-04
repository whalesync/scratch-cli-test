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
  authType: 'api-token' | 'agent-token' | 'jwt';
  authSource: 'user' | 'agent' | 'cli';
  clerkUser?: ClerkUser;
  apiToken?: ApiToken;
};

// (Chris) I know there is likely a better Typescript way to do this globally for the server but I didn't have time to figure it out yet
export interface RequestWithUser extends ExpressRequest {
  user: AuthenticatedUser;
}

export interface SocketWithUser extends Socket {
  user: AuthenticatedUser;
}

/**
 * Extension to the Clerk JwtPayload type with our custom session fields
 */
export interface ScratchJwtPayload {
  sub: string; // clerk user id
  fullName?: string;
  primaryEmail?: string;
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
