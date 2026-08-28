/**
 * Result of an admin hard-delete of a user via `DELETE /dev-tools/users/:id`.
 * `deletedWorkbookCount` is how many workbooks were torn down; `organizationDeleted` is true only
 * when the user was the sole member of their organization and it was removed too.
 */
export interface HardDeleteUserResponse {
  deletedWorkbookCount: number;
  organizationDeleted: boolean;
}
