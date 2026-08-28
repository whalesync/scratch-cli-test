import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ScratchPlanType } from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { UserCluster } from 'src/db/cluster-types';
import { DbService } from 'src/db/db.service';
import { StripePaymentService } from 'src/payment/stripe-payment.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { badRequestError, ok } from 'src/types/results';
import type { Actor } from 'src/users/types';
import { UsersService } from 'src/users/users.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { DevToolsService } from './dev-tools.service';

/**
 * Unit tests for the admin "grant a free trial" dev tool. The eligibility rule ("never had a
 * subscription") and the trial length live inside `StripePaymentService.createTrialSubscription`, so
 * here we only assert that `startTrialForUser` resolves the target user, delegates to that method with
 * the right plan, and surfaces its failure as a `BadRequestException`.
 */
describe('DevToolsService.startTrialForUser', () => {
  let service: DevToolsService;
  let usersService: { findOne: jest.Mock };
  let stripePaymentService: { createTrialSubscription: jest.Mock };

  function makeUser(): UserCluster.User {
    return { id: 'usr_target', organizationId: 'org_1' } as unknown as UserCluster.User;
  }

  beforeEach(() => {
    usersService = { findOne: jest.fn() };
    stripePaymentService = { createTrialSubscription: jest.fn() };

    service = new DevToolsService(
      {} as never, // dbService — unused by startTrialForUser
      usersService as unknown as UsersService,
      stripePaymentService as unknown as StripePaymentService,
      {} as never, // subscriptionService — unused
      {} as never, // credentialEncryptionService — unused
      {} as never, // scratchGitService — unused
      {} as never, // workbookService — unused
      {} as never, // auditLogService — unused
      {} as never, // posthogService — unused
    );
  });

  it('throws NotFoundException when the target user does not exist', async () => {
    usersService.findOne.mockResolvedValue(null);

    await expect(service.startTrialForUser('usr_missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(stripePaymentService.createTrialSubscription).not.toHaveBeenCalled();
  });

  it('defaults to the Pro plan and resolves when the trial is created', async () => {
    const user = makeUser();
    usersService.findOne.mockResolvedValue(user);
    stripePaymentService.createTrialSubscription.mockResolvedValue(ok('success'));

    await expect(service.startTrialForUser('usr_target')).resolves.toBeUndefined();
    expect(stripePaymentService.createTrialSubscription).toHaveBeenCalledWith(user, ScratchPlanType.PRO_PLAN);
  });

  it('forwards an explicit plan type', async () => {
    const user = makeUser();
    usersService.findOne.mockResolvedValue(user);
    stripePaymentService.createTrialSubscription.mockResolvedValue(ok('success'));

    await service.startTrialForUser('usr_target', ScratchPlanType.MAX_PLAN);

    expect(stripePaymentService.createTrialSubscription).toHaveBeenCalledWith(user, ScratchPlanType.MAX_PLAN);
  });

  it('surfaces a createTrialSubscription failure as a BadRequestException carrying the message', async () => {
    const user = makeUser();
    usersService.findOne.mockResolvedValue(user);
    stripePaymentService.createTrialSubscription.mockResolvedValue(
      badRequestError('User already has a subscription; cannot start a trial'),
    );

    await expect(service.startTrialForUser('usr_target')).rejects.toThrow('User already has a subscription');
    await expect(service.startTrialForUser('usr_target')).rejects.toBeInstanceOf(BadRequestException);
  });
});

/**
 * Unit tests for the admin hard-delete-a-user dev tool. Asserts the two membership branches (sole
 * member of the org → org cleaned up too; not sole member → user only), the workbook teardown, and the
 * self-delete / missing-user guards. The actual row/repo teardown lives in the collaborating services,
 * so here we assert the orchestration wires them together correctly.
 */
describe('DevToolsService.hardDeleteUser', () => {
  let service: DevToolsService;
  let usersService: {
    findOne: jest.Mock;
    revokeWhalesyncSessionTokens: jest.Mock;
    deleteShadowUserAndOrganization: jest.Mock;
  };
  let workbookService: { findAllForUser: jest.Mock; executeHardDeleteWorkbook: jest.Mock };
  let auditLogService: { logEvent: jest.Mock };
  let posthogService: { trackHardDeleteUser: jest.Mock };
  let userCount: jest.Mock;
  let workbookFindMany: jest.Mock;

  const actingAdmin: Actor = { userId: 'usr_admin', organizationId: 'org_admin' };

  function makeTargetUser(): UserCluster.User {
    return {
      id: 'usr_target',
      email: 'target@example.com',
      organizationId: 'org_target',
    } as unknown as UserCluster.User;
  }

  beforeEach(() => {
    userCount = jest.fn();
    workbookFindMany = jest.fn();
    const dbService = {
      client: { user: { count: userCount }, workbook: { findMany: workbookFindMany } },
    };
    usersService = {
      findOne: jest.fn(),
      revokeWhalesyncSessionTokens: jest.fn().mockResolvedValue(0),
      deleteShadowUserAndOrganization: jest.fn().mockResolvedValue(undefined),
    };
    workbookService = {
      findAllForUser: jest.fn().mockResolvedValue([]),
      executeHardDeleteWorkbook: jest.fn().mockResolvedValue(undefined),
    };
    auditLogService = { logEvent: jest.fn().mockResolvedValue(undefined) };
    posthogService = { trackHardDeleteUser: jest.fn() };

    service = new DevToolsService(
      dbService as unknown as DbService,
      usersService as unknown as UsersService,
      {} as never, // stripePaymentService — unused
      {} as never, // subscriptionService — unused
      {} as never, // credentialEncryptionService — unused
      {} as never, // scratchGitService — unused
      workbookService as unknown as WorkbookService,
      auditLogService as unknown as AuditLogService,
      posthogService as unknown as PostHogService,
    );
  });

  it('throws NotFoundException when the target user does not exist', async () => {
    usersService.findOne.mockResolvedValue(null);

    await expect(service.hardDeleteUser('usr_missing', actingAdmin)).rejects.toBeInstanceOf(NotFoundException);
    expect(usersService.deleteShadowUserAndOrganization).not.toHaveBeenCalled();
  });

  it('refuses to let an admin delete their own account', async () => {
    const selfActor: Actor = { userId: 'usr_target', organizationId: 'org_target' };
    usersService.findOne.mockResolvedValue(makeTargetUser());

    await expect(service.hardDeleteUser('usr_target', selfActor)).rejects.toBeInstanceOf(BadRequestException);
    expect(workbookService.executeHardDeleteWorkbook).not.toHaveBeenCalled();
    expect(usersService.deleteShadowUserAndOrganization).not.toHaveBeenCalled();
  });

  it('sole member: tears down every org workbook and deletes the organization too', async () => {
    usersService.findOne.mockResolvedValue(makeTargetUser());
    userCount.mockResolvedValue(1); // the target is the only member
    workbookFindMany.mockResolvedValue([{ id: 'wkb_1' }, { id: 'wkb_2' }]);

    const result = await service.hardDeleteUser('usr_target', actingAdmin);

    expect(workbookFindMany).toHaveBeenCalledWith({ where: { organizationId: 'org_target' }, select: { id: true } });
    expect(workbookService.findAllForUser).not.toHaveBeenCalled();
    expect(workbookService.executeHardDeleteWorkbook).toHaveBeenCalledTimes(2);
    expect(workbookService.executeHardDeleteWorkbook).toHaveBeenCalledWith('wkb_1', { actor: actingAdmin });
    expect(usersService.deleteShadowUserAndOrganization).toHaveBeenCalledWith('usr_target', 'org_target');
    expect(result).toEqual({ deletedWorkbookCount: 2, organizationDeleted: true });
    expect(auditLogService.logEvent).toHaveBeenCalledTimes(1);
    expect(posthogService.trackHardDeleteUser).toHaveBeenCalledTimes(1);
  });

  it('not sole member: deletes no workbooks and preserves the organization', async () => {
    usersService.findOne.mockResolvedValue(makeTargetUser());
    userCount.mockResolvedValue(2); // another member remains

    const result = await service.hardDeleteUser('usr_target', actingAdmin);

    // Org-owned workbooks (including any the user could reach via WorkspacePermission) are left intact.
    expect(workbookFindMany).not.toHaveBeenCalled();
    expect(workbookService.findAllForUser).not.toHaveBeenCalled();
    expect(workbookService.executeHardDeleteWorkbook).not.toHaveBeenCalled();
    // organizationId omitted → the org and its workbooks are left intact.
    expect(usersService.deleteShadowUserAndOrganization).toHaveBeenCalledWith('usr_target', undefined);
    expect(result).toEqual({ deletedWorkbookCount: 0, organizationDeleted: false });
  });
});
