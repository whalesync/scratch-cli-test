/* eslint-disable @typescript-eslint/unbound-method */
import { ForbiddenException } from '@nestjs/common';
import { WorkbookId, WorkspacePermissionId } from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { DbService } from 'src/db/db.service';
import { EmailService } from 'src/email/email.service';
import { PostHogService } from 'src/posthog/posthog.service';
import type { Actor } from 'src/users/types';
import { WorkspacePermissionsService } from '../workspace-permissions.service';

const WORKBOOK_ID = 'wkb_test' as WorkbookId;
const PERMISSION_ID = 'wsp_test' as WorkspacePermissionId;
const ACTOR: Actor = {
  userId: 'usr_actor',
  organizationId: 'org_test',
  authSource: 'user',
};

function createMockPermission(overrides: Partial<{ userId: string }> = {}) {
  return {
    id: PERMISSION_ID,
    workbookId: WORKBOOK_ID,
    role: 'editor',
    userId: ACTOR.userId,
    user: { email: 'actor@example.com', name: 'Actor', role: 'user' },
    ...overrides,
  };
}

describe('WorkspacePermissionsService.delete', () => {
  let service: WorkspacePermissionsService;
  let dbService: jest.Mocked<DbService>;

  function setup(opts: {
    permission: ReturnType<typeof createMockPermission> | null;
    workbookCreatorUserId?: string | null;
    numberOfUsersWithAccess?: number;
  }) {
    dbService = {
      client: {
        workspacePermission: {
          findUnique: jest.fn().mockResolvedValue(opts.permission),
          delete: jest.fn().mockResolvedValue({}),
          count: jest.fn().mockResolvedValue(opts.numberOfUsersWithAccess ?? 2),
        },
        workbook: {
          findUnique: jest
            .fn()
            .mockResolvedValue(
              opts.workbookCreatorUserId === undefined ? null : { userId: opts.workbookCreatorUserId },
            ),
        },
      },
    } as unknown as jest.Mocked<DbService>;

    const posthogService = { captureEvent: jest.fn() } as unknown as jest.Mocked<PostHogService>;
    const auditLogService = {
      logEvent: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AuditLogService>;
    const emailService = {} as unknown as jest.Mocked<EmailService>;

    service = new WorkspacePermissionsService(dbService, posthogService, auditLogService, emailService);
  }

  it('blocks self-removal when the actor is the workspace creator owner', async () => {
    setup({
      permission: createMockPermission({ userId: ACTOR.userId }),
      workbookCreatorUserId: ACTOR.userId,
      numberOfUsersWithAccess: 3,
    });

    await expect(service.delete(PERMISSION_ID, ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
    expect(dbService.client.workspacePermission.delete).not.toHaveBeenCalled();
  });

  it('blocks another user from removing the workspace creator owner', async () => {
    // Actor (e.g. bob) tries to remove the owner's (e.g. chris) permission.
    setup({
      permission: createMockPermission({ userId: 'usr_owner' }),
      workbookCreatorUserId: 'usr_owner',
      numberOfUsersWithAccess: 2,
    });

    await expect(service.delete(PERMISSION_ID, ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
    expect(dbService.client.workspacePermission.delete).not.toHaveBeenCalled();
  });

  it('blocks self-removal when the actor is the only user with access', async () => {
    setup({
      permission: createMockPermission({ userId: ACTOR.userId }),
      workbookCreatorUserId: 'usr_someone_else',
      numberOfUsersWithAccess: 1,
    });

    await expect(service.delete(PERMISSION_ID, ACTOR)).rejects.toBeInstanceOf(ForbiddenException);
    expect(dbService.client.workspacePermission.delete).not.toHaveBeenCalled();
  });

  it('allows self-removal when the actor is neither the creator owner nor the only user', async () => {
    setup({
      permission: createMockPermission({ userId: ACTOR.userId }),
      workbookCreatorUserId: 'usr_someone_else',
      numberOfUsersWithAccess: 2,
    });

    await service.delete(PERMISSION_ID, ACTOR);

    expect(dbService.client.workspacePermission.delete).toHaveBeenCalledWith({ where: { id: PERMISSION_ID } });
  });

  it('allows removing another user who is not the workspace creator owner', async () => {
    setup({
      permission: createMockPermission({ userId: 'usr_other' }),
      workbookCreatorUserId: ACTOR.userId,
      numberOfUsersWithAccess: 3,
    });

    await service.delete(PERMISSION_ID, ACTOR);

    expect(dbService.client.workspacePermission.delete).toHaveBeenCalledWith({ where: { id: PERMISSION_ID } });
    // Removing another user is not self-removal, so the only-user count check is skipped.
    expect(dbService.client.workspacePermission.count).not.toHaveBeenCalled();
  });
});
