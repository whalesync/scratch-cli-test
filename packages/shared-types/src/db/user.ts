import { SubscriptionInfo } from '../subscription';
import { Organization } from './organization';
import { WorkspacePermission } from './workspace-permission';

/**
 * User-scoped feature-flag values resolved by the server and returned on the
 * `User`. Keys are the client-facing flags; values are booleans (a flag absent
 * from the payload is treated as `false` — consumers should check `=== true`).
 */
export interface UserExperimentFlags {
  DEV_TOOLBOX: boolean;
  ENABLE_CREATE_BUG_REPORT: boolean;
  SHOW_OPEN_IN_DESKTOP: boolean;
  ENABLE_GENERIC_CONNECTOR: boolean;
  ENABLE_PUBLISH_HISTORY: boolean;
  ENABLE_SCRATCH_FOLDERS: boolean;
  DESKTOP_REVIEW_SURFACE_V2: boolean;
}

/**
 * The current user as returned by `GET /users/current` (and embedded elsewhere).
 *
 * NOTE: timestamps are ISO-8601 strings on the wire (the server entity holds
 * `Date`s; they serialize to strings). The server's `User` entity currently does
 * not formally `implement` this type — reconciling it (Date→string + the
 * `experimentalFlags` shape) is tracked follow-up.
 */
export interface User {
  id: string;
  clerkId: string | null;
  whalesyncUserId: string | null;
  createdAt: string;
  updatedAt: string;
  isAdmin: boolean;
  name?: string;
  email?: string;
  /** Token for the client to use for the Scratch API websocket connection. */
  websocketToken?: string;
  /** The user's API token for external API access (CLI, integrations, etc.). */
  apiToken?: string;
  stripeCustomerId?: string | null;
  subscription?: SubscriptionInfo;
  experimentalFlags?: UserExperimentFlags;
  organization?: Organization;
  settings?: Record<string, string | number | boolean>;
  /** ID of the last workbook the user viewed (for quick redirect on the home page). */
  lastWorkbookId?: string;
  waitlistApproved: boolean;
  serverBuildVersion?: string;
  workspacePermissions?: WorkspacePermission[];
}
