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

function createAccessCountService(
  permissionRows: Array<{ workbookId: string; userId: string; organizationId: string | null }>,
  organizationWorkbooks: Array<{ id: string; userId: string | null; organizationId: string }> = [],
) {
  const permissionFindManyMock = jest.fn().mockResolvedValue(
    permissionRows.map((row) => ({
      workbookId: row.workbookId,
      userId: row.userId,
      user: { organizationId: row.organizationId },
    })),
  );
  const workbookFindManyMock = jest.fn().mockResolvedValue(organizationWorkbooks);
  const dbService = {
    client: {
      workspacePermission: { findMany: permissionFindManyMock },
      workbook: { findMany: workbookFindManyMock },
    },
  } as unknown as jest.Mocked<DbService>;

  const posthogService = {} as unknown as jest.Mocked<PostHogService>;
  const auditLogService = {} as unknown as jest.Mocked<AuditLogService>;
  const emailService = {} as unknown as jest.Mocked<EmailService>;

  const service = new WorkspacePermissionsService(dbService, posthogService, auditLogService, emailService);
  return { service, permissionFindManyMock, workbookFindManyMock };
}

describe('WorkspacePermissionsService.getSharedAccessCountsByWorkbookIds', () => {
  it('excludes the owner and counts non-org (external) shared users per workbook', async () => {
    const { service } = createAccessCountService([
      // Workbook A (org_1, owned by usr_owner_a): owner + one in-org member + two external holders.
      { workbookId: 'wkb_a', userId: 'usr_owner_a', organizationId: 'org_1' },
      { workbookId: 'wkb_a', userId: 'usr_member', organizationId: 'org_1' },
      { workbookId: 'wkb_a', userId: 'usr_external', organizationId: 'org_2' },
      { workbookId: 'wkb_a', userId: 'usr_no_org', organizationId: null },
      // Workbook B (org_1, orphaned owner=null): a single in-org member counts as shared-with.
      { workbookId: 'wkb_b', userId: 'usr_member', organizationId: 'org_1' },
      // Workbook C (org_1, owned by usr_owner_c): only the owner has a permission → unshared.
      { workbookId: 'wkb_c', userId: 'usr_owner_c', organizationId: 'org_1' },
    ]);

    const counts = await service.getSharedAccessCountsByWorkbookIds([
      { id: 'wkb_a', organizationId: 'org_1', ownerUserId: 'usr_owner_a' },
      { id: 'wkb_b', organizationId: 'org_1', ownerUserId: null },
      { id: 'wkb_c', organizationId: 'org_1', ownerUserId: 'usr_owner_c' },
    ]);

    expect(counts.get('wkb_a')).toEqual({ sharedWithUserCount: 3, nonOrgUserCount: 2 });
    expect(counts.get('wkb_b')).toEqual({ sharedWithUserCount: 1, nonOrgUserCount: 0 });
    expect(counts.get('wkb_c')).toEqual({ sharedWithUserCount: 0, nonOrgUserCount: 0 });
  });

  it('returns an empty map and issues no query when given no workbooks', async () => {
    const { service, permissionFindManyMock } = createAccessCountService([]);

    const counts = await service.getSharedAccessCountsByWorkbookIds([]);

    expect(counts.size).toBe(0);
    expect(permissionFindManyMock).not.toHaveBeenCalled();
  });
});

describe('WorkspacePermissionsService.countExternallySharedWorkbooksInOrganization', () => {
  it('counts org-owned workbooks shared with at least one non-org (external) user', async () => {
    const { service } = createAccessCountService(
      [
        // wkb_a (owned by usr_owner_a): owner + an external holder → externally shared.
        { workbookId: 'wkb_a', userId: 'usr_owner_a', organizationId: 'org_1' },
        { workbookId: 'wkb_a', userId: 'usr_external', organizationId: 'org_2' },
        // wkb_b (owned by usr_owner_b): owner + an in-org member → shared, but not externally.
        { workbookId: 'wkb_b', userId: 'usr_owner_b', organizationId: 'org_1' },
        { workbookId: 'wkb_b', userId: 'usr_member', organizationId: 'org_1' },
        // wkb_c (owned by usr_owner_c): only the owner → not shared at all.
        { workbookId: 'wkb_c', userId: 'usr_owner_c', organizationId: 'org_1' },
      ],
      [
        { id: 'wkb_a', userId: 'usr_owner_a', organizationId: 'org_1' },
        { id: 'wkb_b', userId: 'usr_owner_b', organizationId: 'org_1' },
        { id: 'wkb_c', userId: 'usr_owner_c', organizationId: 'org_1' },
      ],
    );

    await expect(service.countExternallySharedWorkbooksInOrganization('org_1')).resolves.toBe(1);
  });

  it('returns 0 when the organization owns no externally shared workbooks', async () => {
    const { service } = createAccessCountService(
      [{ workbookId: 'wkb_only', userId: 'usr_owner', organizationId: 'org_1' }],
      [{ id: 'wkb_only', userId: 'usr_owner', organizationId: 'org_1' }],
    );

    await expect(service.countExternallySharedWorkbooksInOrganization('org_1')).resolves.toBe(0);
  });
});
