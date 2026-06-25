import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ScratchPlanType } from '@spinner/shared-types';
import { UserCluster } from 'src/db/cluster-types';
import { StripePaymentService } from 'src/payment/stripe-payment.service';
import { badRequestError, ok } from 'src/types/results';
import { UsersService } from 'src/users/users.service';
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
