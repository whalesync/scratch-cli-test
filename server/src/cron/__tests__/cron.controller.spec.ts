import { UnauthorizedException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { RequestWithUser } from 'src/auth/types';
import { CRON_JOB_DEFINITIONS } from '../cron-job-definitions';
import { CronController } from '../cron.controller';

const ADMIN_REQ = { user: { id: 'usr_admin', role: UserRole.ADMIN, authType: 'jwt' } } as unknown as RequestWithUser;
const NON_ADMIN_REQ = { user: { id: 'usr_user', role: UserRole.USER, authType: 'jwt' } } as unknown as RequestWithUser;

describe('CronController', () => {
  let controller: CronController;

  const originalRunningInCloud = process.env.RUNNING_IN_CLOUD;
  const originalAppEnv = process.env.APP_ENV;
  const restoreEnvVar = (name: string, value: string | undefined): void => {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  };
  afterEach(() => {
    restoreEnvVar('RUNNING_IN_CLOUD', originalRunningInCloud);
    restoreEnvVar('APP_ENV', originalAppEnv);
  });

  beforeEach(() => {
    // Default to local dev unless a test opts into a deployed environment.
    delete process.env.RUNNING_IN_CLOUD;
    controller = new CronController();
  });

  it('rejects non-admins from listing jobs', () => {
    expect(() => controller.listCronJobs(NON_ADMIN_REQ)).toThrow(UnauthorizedException);
  });

  it('lists every cron job with a slug, description, and schedule', () => {
    const { jobs } = controller.listCronJobs(ADMIN_REQ);
    expect(jobs).toEqual(CRON_JOB_DEFINITIONS);
    expect(jobs.map((job) => job.slug).sort()).toEqual([
      'expired-api-token-cleanup',
      'old-job-cleanup',
      'record-count-refresh',
      'routine-run-reaper',
      'scratch-git-disk-observability',
      'stale-active-job-reaper',
      'stale-job-reaper',
    ]);
    for (const job of jobs) {
      expect(job.description.length).toBeGreaterThan(0);
      expect(job.schedule.length).toBeGreaterThan(0);
    }
  });

  it('reports canTrigger:true in local dev (RUNNING_IN_CLOUD unset)', () => {
    expect(controller.listCronJobs(ADMIN_REQ).canTrigger).toBe(true);
  });

  it('has no cron service logs URL in local dev', () => {
    expect(controller.listCronJobs(ADMIN_REQ).cronServiceLogsUrl).toBeNull();
  });

  describe('deployed environment', () => {
    beforeEach(() => {
      process.env.RUNNING_IN_CLOUD = 'true';
      process.env.APP_ENV = 'test';
    });

    it('reports canTrigger:false', () => {
      expect(controller.listCronJobs(ADMIN_REQ).canTrigger).toBe(false);
    });

    it('returns a GCP Cloud Logging deep link scoped to the environment project and cron service', () => {
      const { cronServiceLogsUrl } = controller.listCronJobs(ADMIN_REQ);
      expect(cronServiceLogsUrl).not.toBeNull();
      if (cronServiceLogsUrl) {
        expect(cronServiceLogsUrl).toContain('https://console.cloud.google.com/logs/query');
        expect(cronServiceLogsUrl).toContain('project=spv1eu-test');
        expect(decodeURIComponent(cronServiceLogsUrl)).toContain('resource.labels.service_name = "cron-service"');
      }
    });

    it('scopes the logs link to the production project when APP_ENV=production', () => {
      process.env.APP_ENV = 'production';
      expect(controller.listCronJobs(ADMIN_REQ).cronServiceLogsUrl).toContain('project=spv1eu-production');
    });
  });
});
