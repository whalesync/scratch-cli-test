import { DbService } from 'src/db/db.service';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { SystemFeatureFlag } from 'src/experiments/flags';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { SubscriptionEnforcementService } from '../subscription-enforcement.service';

describe('SubscriptionEnforcementService', () => {
  let service: SubscriptionEnforcementService;
  let subscriptionFindMany: jest.Mock;
  let scheduleUpdateMany: jest.Mock;
  let logValue: jest.Mock;
  let getBooleanFlag: jest.Mock;

  const future = new Date(Date.now() + 86400000);
  const past = new Date(Date.now() - 86400000);

  beforeEach(() => {
    jest.spyOn(WSLogger, 'info').mockImplementation(() => {});
    jest.spyOn(WSLogger, 'warn').mockImplementation(() => {});

    subscriptionFindMany = jest.fn();
    scheduleUpdateMany = jest.fn().mockResolvedValue({ count: 3 });
    logValue = jest.fn();
    // Enablement gate on (enforcement enabled) for the enforcement-path tests; the gate tests flip it off.
    getBooleanFlag = jest.fn().mockResolvedValue(true);

    const mockDb = {
      client: {
        subscription: { findMany: subscriptionFindMany },
        schedule: { updateMany: scheduleUpdateMany },
      },
    } as unknown as DbService;
    const mockMetrics = { logValue } as unknown as CustomMetricsService;
    const mockExperiments = { getBooleanFlag } as unknown as ExperimentsService;

    service = new SubscriptionEnforcementService(mockDb, mockMetrics, mockExperiments);
  });

  it('disables all schedules for a lapsed org and emits the counter', async () => {
    subscriptionFindMany.mockImplementation((args: { where: { organizationId?: string }; distinct?: unknown }) => {
      if (args.distinct) {
        return Promise.resolve([{ organizationId: 'org_lapsed' }]);
      }
      if (args.where.organizationId === 'org_lapsed') {
        return Promise.resolve([{ stripeStatus: 'canceled', expiration: past }]);
      }
      return Promise.resolve([]);
    });

    await service.enforceLapsedSubscriptions();

    expect(scheduleUpdateMany).toHaveBeenCalledTimes(1);
    expect(scheduleUpdateMany).toHaveBeenCalledWith({
      where: { organizationId: 'org_lapsed', enabled: true },
      data: { enabled: false },
    });
    expect(logValue).toHaveBeenCalledWith(CustomMetric.SUBSCRIPTION_LAPSE_SCHEDULES_DISABLED, 3);
  });

  it('spares an org that still holds a healthy (active) subscription', async () => {
    subscriptionFindMany.mockImplementation((args: { distinct?: unknown }) => {
      if (args.distinct) {
        return Promise.resolve([{ organizationId: 'org_mixed' }]);
      }
      // A lapsed WHALESYNC row AND a genuinely active paid plan → must NOT be enforced.
      return Promise.resolve([
        { stripeStatus: 'canceled', expiration: past },
        { stripeStatus: 'active', expiration: future },
      ]);
    });

    await service.enforceLapsedSubscriptions();

    expect(scheduleUpdateMany).not.toHaveBeenCalled();
    expect(logValue).not.toHaveBeenCalled();
  });

  it('enforces an org whose only subscription is past_due (past_due is not healthy)', async () => {
    subscriptionFindMany.mockImplementation((args: { distinct?: unknown }) => {
      if (args.distinct) {
        return Promise.resolve([{ organizationId: 'org_pastdue' }]);
      }
      return Promise.resolve([{ stripeStatus: 'past_due', expiration: future }]);
    });

    await service.enforceLapsedSubscriptions();

    expect(scheduleUpdateMany).toHaveBeenCalledTimes(1);
    expect(scheduleUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org_pastdue', enabled: true } }),
    );
  });

  it('does nothing when no subscriptions lapsed in the window', async () => {
    subscriptionFindMany.mockResolvedValue([]);

    await service.enforceLapsedSubscriptions();

    expect(scheduleUpdateMany).not.toHaveBeenCalled();
    expect(logValue).not.toHaveBeenCalled();
  });

  it('does not emit the counter when an org had no enabled schedules to disable', async () => {
    scheduleUpdateMany.mockResolvedValue({ count: 0 });
    subscriptionFindMany.mockImplementation((args: { distinct?: unknown }) => {
      if (args.distinct) {
        return Promise.resolve([{ organizationId: 'org_lapsed' }]);
      }
      return Promise.resolve([{ stripeStatus: 'canceled', expiration: past }]);
    });

    await service.enforceLapsedSubscriptions();

    expect(scheduleUpdateMany).toHaveBeenCalledTimes(1);
    expect(logValue).not.toHaveBeenCalled();
  });

  it('evaluates the enablement flag fail-closed (default false)', async () => {
    subscriptionFindMany.mockResolvedValue([]);

    await service.enforceLapsedSubscriptions();

    expect(getBooleanFlag).toHaveBeenCalledWith(SystemFeatureFlag.SUBSCRIPTION_ENFORCEMENT_ENABLED, false);
  });

  it('skips the entire sweep when the enablement flag is off', async () => {
    getBooleanFlag.mockResolvedValue(false);

    await service.enforceLapsedSubscriptions();

    expect(subscriptionFindMany).not.toHaveBeenCalled();
    expect(scheduleUpdateMany).not.toHaveBeenCalled();
    expect(logValue).not.toHaveBeenCalled();
  });
});
