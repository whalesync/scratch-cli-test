import { Prisma, type WhalesyncRunNotification } from '@prisma/client';
import { RoutineRunId } from '@spinner/shared-types';
import axios, { AxiosError, AxiosHeaders, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { SystemFeatureFlag } from 'src/experiments/flags';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import {
  MAX_WHALESYNC_RUN_NOTIFICATION_DELIVERY_ATTEMPTS,
  WhalesyncRunNotifierService,
  whalesyncRunNotificationRetryBackoffMinutes,
} from '../whalesync-run-notifier.service';

const RUN_ID = 'rrn_test1234' as RoutineRunId;
const WORKBOOK_ID = 'wkb_test1234';
const WHALESYNC_USER_ID = '3f1c2a4e-5b6d-4c7e-8f90-a1b2c3d4e5f6';
const WHALESYNC_INTERNAL_API_URL = 'https://test-bottlenose.example.com';
const NOTIFICATION_URL = `${WHALESYNC_INTERNAL_API_URL}/internal/scratch/live-export-runs/finished`;
const SERVICE_TOKEN = 'super-secret-service-token-value';
const FINISHED_AT = new Date('2026-10-15T15:02:11.000Z');

/** The run row as `enqueueNotificationIfRunIsEligible` selects it: a failed Live Export run with a Whalesync owner. */
function failedLiveExportRun(
  overrides: Record<string, unknown> = {},
  workbookOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: RUN_ID,
    workbookId: WORKBOOK_ID,
    routineFilePath: 'routines/run-syn_1.yaml',
    status: 'failed',
    trigger: 'schedule',
    finishedAt: FINISHED_AT,
    resultSummary: 'Supabase rejected the credentials',
    resultWarning: null,
    error: 'Step 2 (publish) failed: Supabase rejected the credentials',
    liveExportEngine: 'classic',
    workbook: {
      name: 'Intercom → Supabase',
      managedBy: 'ws_export',
      isPendingDelete: false,
      user: { whalesyncUserId: WHALESYNC_USER_ID },
      ...workbookOverrides,
    },
    ...overrides,
  };
}

const EXPECTED_PAYLOAD = {
  whalesyncUserId: WHALESYNC_USER_ID,
  workbookId: WORKBOOK_ID,
  workbookName: 'Intercom → Supabase',
  routineFilePath: 'routines/run-syn_1.yaml',
  runId: RUN_ID,
  status: 'failed',
  trigger: 'schedule',
  finishedAt: '2026-10-15T15:02:11.000Z',
  resultSummary: 'Supabase rejected the credentials',
  resultWarning: null,
  error: 'Step 2 (publish) failed: Supabase rejected the credentials',
  liveExportEngine: 'classic',
};

function queuedNotification(overrides: Partial<WhalesyncRunNotification> = {}): WhalesyncRunNotification {
  return {
    id: 'wrn_row_1',
    createdAt: new Date(),
    routineRunId: RUN_ID,
    workbookId: WORKBOOK_ID,
    payload: EXPECTED_PAYLOAD,
    attempts: 0,
    nextAttemptAt: new Date(),
    deliveredAt: null,
    lastError: null,
    ...overrides,
  };
}

function makeNotifier(
  options: {
    whalesyncInternalApiUrl?: string;
    serviceToken?: string;
    flagEnabled?: boolean;
    run?: Record<string, unknown> | null;
  } = {},
) {
  const routineRunFindUnique = jest
    .fn()
    .mockResolvedValue(options.run === undefined ? failedLiveExportRun() : options.run);
  const notificationCreate = jest.fn().mockResolvedValue({});
  const notificationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const db = {
    client: {
      routineRun: { findUnique: routineRunFindUnique },
      whalesyncRunNotification: { create: notificationCreate, updateMany: notificationUpdateMany },
    },
  } as unknown as DbService;
  const configService = {
    getWhalesyncInternalApiUrl: jest
      .fn()
      .mockReturnValue(
        'whalesyncInternalApiUrl' in options ? options.whalesyncInternalApiUrl : WHALESYNC_INTERNAL_API_URL,
      ),
    getWhalesyncServiceToken: jest
      .fn()
      .mockReturnValue('serviceToken' in options ? options.serviceToken : SERVICE_TOKEN),
  } as unknown as ScratchConfigService;
  const getBooleanFlag = jest.fn().mockResolvedValue(options.flagEnabled ?? true);
  const logValue = jest.fn();
  const notifier = new WhalesyncRunNotifierService(
    db,
    configService,
    { getBooleanFlag } as unknown as ExperimentsService,
    { logValue } as unknown as CustomMetricsService,
  );
  return { notifier, routineRunFindUnique, notificationCreate, notificationUpdateMany, getBooleanFlag, logValue };
}

/** A request config like the one axios builds, service-token header included, as a real AxiosError carries it. */
function requestConfigWithServiceToken(): InternalAxiosRequestConfig {
  return { headers: new AxiosHeaders({ 'X-Scratch-Service-Token': SERVICE_TOKEN }) };
}

function axiosHttpError(status: number, data: unknown = { message: 'nope' }): AxiosError {
  const config = requestConfigWithServiceToken();
  return new AxiosError(
    `Request failed with status code ${status}`,
    AxiosError.ERR_BAD_RESPONSE,
    config,
    {},
    {
      status,
      statusText: '',
      data,
      headers: {},
      config,
    },
  );
}

function axiosNoResponseError(code: string, message: string): AxiosError {
  return new AxiosError(message, code, requestConfigWithServiceToken(), {});
}

function whalesyncResponse(status: number, data: unknown): AxiosResponse {
  return { status, statusText: '', data, headers: {}, config: requestConfigWithServiceToken() };
}

function expectDateAboutMinutesFromNow(actual: unknown, expectedMinutes: number, testStartedAtMs: number): void {
  expect(actual).toBeInstanceOf(Date);
  const actualMs = (actual as Date).getTime();
  expect(actualMs).toBeGreaterThanOrEqual(testStartedAtMs + expectedMinutes * 60_000);
  expect(actualMs).toBeLessThanOrEqual(Date.now() + expectedMinutes * 60_000);
}

describe('WhalesyncRunNotifierService', () => {
  let post: jest.SpyInstance;
  let infoLog: jest.SpyInstance;
  let warnLog: jest.SpyInstance;
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    post = jest.spyOn(axios, 'post');
    infoLog = jest.spyOn(WSLogger, 'info').mockImplementation(() => {});
    warnLog = jest.spyOn(WSLogger, 'warn').mockImplementation(() => {});
    errorLog = jest.spyOn(WSLogger, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  describe('onModuleInit', () => {
    it('logs once that notifications are off when Whalesync is not configured', () => {
      const { notifier } = makeNotifier({ serviceToken: undefined });
      notifier.onModuleInit();
      expect(infoLog).toHaveBeenCalledTimes(1);
      expect(infoLog).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('Whalesync run notifications are off') as unknown }),
      );
    });

    it('stays quiet when Whalesync is configured', () => {
      const { notifier } = makeNotifier();
      notifier.onModuleInit();
      expect(infoLog).not.toHaveBeenCalled();
    });
  });

  describe('enqueueForRun', () => {
    it.each([
      ['WHALESYNC_INTERNAL_API_URL', { whalesyncInternalApiUrl: undefined }],
      ['WHALESYNC_SERVICE_TOKEN', { serviceToken: undefined }],
    ])('does nothing, without asking PostHog, when %s is unset', async (_variable, configOverrides) => {
      const { notifier, getBooleanFlag, routineRunFindUnique, notificationCreate } = makeNotifier(configOverrides);
      await notifier.enqueueForRun(RUN_ID);
      expect(getBooleanFlag).not.toHaveBeenCalled();
      expect(routineRunFindUnique).not.toHaveBeenCalled();
      expect(notificationCreate).not.toHaveBeenCalled();
    });

    it('does nothing when the kill switch is off, evaluating it fail-closed with no user', async () => {
      const { notifier, getBooleanFlag, routineRunFindUnique } = makeNotifier({ flagEnabled: false });
      await notifier.enqueueForRun(RUN_ID);
      expect(getBooleanFlag).toHaveBeenCalledWith(SystemFeatureFlag.LIVE_EXPORT_RUN_NOTIFY_WHALESYNC_ENABLED, false);
      expect(routineRunFindUnique).not.toHaveBeenCalled();
    });

    it('queues the validated payload for a failed Live Export run, without calling Whalesync', async () => {
      const { notifier, notificationCreate } = makeNotifier();
      await notifier.enqueueForRun(RUN_ID);
      expect(notificationCreate).toHaveBeenCalledWith({
        data: { routineRunId: RUN_ID, workbookId: WORKBOOK_ID, payload: EXPECTED_PAYLOAD },
      });
      expect(post).not.toHaveBeenCalled();
    });

    it('never throws: a failure is logged and swallowed', async () => {
      const { notifier, routineRunFindUnique } = makeNotifier();
      routineRunFindUnique.mockRejectedValue(new Error('db down'));
      await expect(notifier.enqueueForRun(RUN_ID)).resolves.toBeUndefined();
      expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ routineRunId: RUN_ID }));
    });
  });

  describe('enqueueNotificationIfRunIsEligible', () => {
    it('returns true when it queues a notification', async () => {
      const { notifier, notificationCreate } = makeNotifier();
      await expect(notifier.enqueueNotificationIfRunIsEligible(RUN_ID)).resolves.toBe(true);
      expect(notificationCreate).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['the run is gone', null],
      ['the run did not fail', failedLiveExportRun({ status: 'completed' })],
      ['the run was cancelled', failedLiveExportRun({ status: 'cancelled' })],
      ['the workbook is not a Live Export', failedLiveExportRun({}, { managedBy: null })],
      ['the workbook is being deleted', failedLiveExportRun({}, { isPendingDelete: true })],
      ['the workbook has no owner', failedLiveExportRun({}, { user: null })],
      ['the owner is not a Whalesync user', failedLiveExportRun({}, { user: { whalesyncUserId: null } })],
    ])('skips the run when %s', async (_reason, run) => {
      const { notifier, notificationCreate } = makeNotifier({ run });
      await expect(notifier.enqueueNotificationIfRunIsEligible(RUN_ID)).resolves.toBe(false);
      expect(notificationCreate).not.toHaveBeenCalled();
    });

    it("names the team of a team's shadow user, which has no person of its own", async () => {
      const { notifier, notificationCreate } = makeNotifier({
        run: failedLiveExportRun({}, { user: { whalesyncUserId: null, whalesyncTeamId: 'tm_abc123def456' } }),
      });

      await expect(notifier.enqueueNotificationIfRunIsEligible(RUN_ID)).resolves.toBe(true);

      const [[{ data }]] = notificationCreate.mock.calls as [[{ data: { payload: Record<string, unknown> } }]];
      expect(data.payload).toEqual({
        ...EXPECTED_PAYLOAD,
        whalesyncUserId: undefined,
        whalesyncTeamId: 'tm_abc123def456',
      });
      expect(data.payload).not.toHaveProperty('whalesyncUserId');
    });

    it('names both the team and the person for a shadow user from before teams that has its team', async () => {
      const { notifier, notificationCreate } = makeNotifier({
        run: failedLiveExportRun(
          {},
          { user: { whalesyncUserId: WHALESYNC_USER_ID, whalesyncTeamId: 'tm_abc123def456' } },
        ),
      });

      await notifier.enqueueNotificationIfRunIsEligible(RUN_ID);

      expect(notificationCreate).toHaveBeenCalledWith({
        data: {
          routineRunId: RUN_ID,
          workbookId: WORKBOOK_ID,
          payload: { ...EXPECTED_PAYLOAD, whalesyncTeamId: 'tm_abc123def456' },
        },
      });
    });

    it('names an unnamed workbook the way Whalesync does', async () => {
      const { notifier, notificationCreate } = makeNotifier({ run: failedLiveExportRun({}, { name: null }) });
      await notifier.enqueueNotificationIfRunIsEligible(RUN_ID);
      expect(notificationCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({ workbookName: 'Untitled export' }) as unknown,
        }) as unknown,
      });
    });

    it('sends an engine the contract does not know as null rather than dropping the notification', async () => {
      const { notifier, notificationCreate } = makeNotifier({
        run: failedLiveExportRun({ liveExportEngine: 'some_future_engine' }),
      });
      await expect(notifier.enqueueNotificationIfRunIsEligible(RUN_ID)).resolves.toBe(true);
      expect(notificationCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({ liveExportEngine: null }) as unknown,
        }) as unknown,
      });
    });

    it('records an invalid payload as given up instead of queuing it for delivery', async () => {
      const { notifier, notificationCreate, logValue } = makeNotifier({
        run: failedLiveExportRun({}, { user: { whalesyncUserId: 'not-a-uuid' } }),
      });
      await expect(notifier.enqueueNotificationIfRunIsEligible(RUN_ID)).resolves.toBe(false);
      expect(notificationCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          routineRunId: RUN_ID,
          attempts: MAX_WHALESYNC_RUN_NOTIFICATION_DELIVERY_ATTEMPTS,
          lastError: expect.stringContaining('Invalid notification payload: whalesyncUserId') as unknown,
        }) as unknown,
      });
      expect(logValue).toHaveBeenCalledWith(CustomMetric.WHALESYNC_RUN_NOTIFY_GAVE_UP, 1);
      expect(errorLog).toHaveBeenCalledTimes(1);
    });

    it.each(['P2002', 'P2003'])('returns false quietly when the insert hits %s', async (code) => {
      const { notifier, notificationCreate } = makeNotifier();
      notificationCreate.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('conflict', { code, clientVersion: 'test' }),
      );
      await expect(notifier.enqueueNotificationIfRunIsEligible(RUN_ID)).resolves.toBe(false);
      expect(errorLog).not.toHaveBeenCalled();
    });

    it('rethrows any other insert error', async () => {
      const { notifier, notificationCreate } = makeNotifier();
      notificationCreate.mockRejectedValue(new Error('db down'));
      await expect(notifier.enqueueNotificationIfRunIsEligible(RUN_ID)).rejects.toThrow('db down');
    });
  });

  describe('deliverNotificationToWhalesync', () => {
    it('POSTs the stored payload with the service token, a timeout, and no redirects', async () => {
      const { notifier } = makeNotifier();
      post.mockResolvedValue(whalesyncResponse(200, { outcome: 'emailed' }));
      await notifier.deliverNotificationToWhalesync(queuedNotification());
      expect(post).toHaveBeenCalledWith(NOTIFICATION_URL, EXPECTED_PAYLOAD, {
        timeout: 10_000,
        maxRedirects: 0,
        headers: { 'X-Scratch-Service-Token': SERVICE_TOKEN },
      });
    });

    it('marks the row delivered on a 2xx with an outcome', async () => {
      const { notifier, notificationUpdateMany, logValue } = makeNotifier();
      post.mockResolvedValue(whalesyncResponse(200, { outcome: 'throttled' }));
      await expect(notifier.deliverNotificationToWhalesync(queuedNotification())).resolves.toBe('delivered');
      expect(notificationUpdateMany).toHaveBeenCalledWith({
        where: { id: 'wrn_row_1', deliveredAt: null },
        data: { deliveredAt: expect.any(Date) as unknown, lastError: null },
      });
      expect(logValue).toHaveBeenCalledWith(CustomMetric.WHALESYNC_RUN_NOTIFY_SENT, 1);
      expect(infoLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'throttled' }));
    });

    it('still counts an outcome it does not know as delivered, with a warning', async () => {
      const { notifier, logValue } = makeNotifier();
      post.mockResolvedValue(whalesyncResponse(200, { outcome: 'some_new_outcome' }));
      await expect(notifier.deliverNotificationToWhalesync(queuedNotification())).resolves.toBe('delivered');
      expect(logValue).toHaveBeenCalledWith(CustomMetric.WHALESYNC_RUN_NOTIFY_SENT, 1);
      expect(warnLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'some_new_outcome' }));
    });

    it('retries a 2xx that carries no outcome (something other than Whalesync answered)', async () => {
      const { notifier, notificationUpdateMany } = makeNotifier();
      post.mockResolvedValue(whalesyncResponse(200, '<html>hello</html>'));
      await expect(notifier.deliverNotificationToWhalesync(queuedNotification())).resolves.toBe('will_retry');
      expect(notificationUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            attempts: 1,
            lastError: expect.stringContaining('without an outcome') as unknown,
          }) as unknown,
        }),
      );
    });

    it.each([
      ['a 500', () => axiosHttpError(500)],
      ['a 503', () => axiosHttpError(503)],
      ['a 401 (token mismatch while rotating)', () => axiosHttpError(401)],
      ['a 403', () => axiosHttpError(403)],
      ['a 404 (bottlenose not deployed or reverted)', () => axiosHttpError(404)],
      ['a 408', () => axiosHttpError(408)],
      ['a 429', () => axiosHttpError(429)],
      ['a redirect', () => axiosHttpError(302)],
      ['a refused connection', () => axiosNoResponseError('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.1:443')],
      ['a timeout', () => axiosNoResponseError('ECONNABORTED', 'timeout of 10000ms exceeded')],
    ])('reschedules with backoff after %s', async (_failure, makeError) => {
      const testStartedAtMs = Date.now();
      const { notifier, notificationUpdateMany, logValue } = makeNotifier();
      post.mockRejectedValue(makeError());
      await expect(notifier.deliverNotificationToWhalesync(queuedNotification())).resolves.toBe('will_retry');

      const [[{ where, data }]] = notificationUpdateMany.mock.calls as [
        [{ where: unknown; data: { attempts: number; nextAttemptAt: Date; lastError: string } }],
      ];
      expect(where).toEqual({ id: 'wrn_row_1', deliveredAt: null });
      expect(data.attempts).toBe(1);
      expectDateAboutMinutesFromNow(data.nextAttemptAt, 2, testStartedAtMs);
      expect(data.lastError.length).toBeGreaterThan(0);
      expect(logValue).toHaveBeenCalledWith(CustomMetric.WHALESYNC_RUN_NOTIFY_FAILED, 1);
      expect(logValue).not.toHaveBeenCalledWith(CustomMetric.WHALESYNC_RUN_NOTIFY_GAVE_UP, 1);
    });

    it('backs off exponentially, capped at an hour', () => {
      expect([1, 2, 3, 4, 5, 6, 9].map(whalesyncRunNotificationRetryBackoffMinutes)).toEqual([2, 4, 8, 16, 32, 60, 60]);
    });

    it('uses the backoff for the attempt that just failed', async () => {
      const testStartedAtMs = Date.now();
      const { notifier, notificationUpdateMany } = makeNotifier();
      post.mockRejectedValue(axiosHttpError(503));
      await notifier.deliverNotificationToWhalesync(queuedNotification({ attempts: 3 }));
      const [[{ data }]] = notificationUpdateMany.mock.calls as [[{ data: { attempts: number; nextAttemptAt: Date } }]];
      expect(data.attempts).toBe(4);
      expectDateAboutMinutesFromNow(data.nextAttemptAt, 16, testStartedAtMs);
    });

    it('gives up when the last allowed attempt fails', async () => {
      const { notifier, notificationUpdateMany, logValue } = makeNotifier();
      post.mockRejectedValue(axiosHttpError(503));
      await expect(
        notifier.deliverNotificationToWhalesync(
          queuedNotification({ attempts: MAX_WHALESYNC_RUN_NOTIFICATION_DELIVERY_ATTEMPTS - 1 }),
        ),
      ).resolves.toBe('gave_up');
      expect(notificationUpdateMany).toHaveBeenCalledWith({
        where: { id: 'wrn_row_1', deliveredAt: null },
        data: { attempts: MAX_WHALESYNC_RUN_NOTIFICATION_DELIVERY_ATTEMPTS, lastError: expect.any(String) as unknown },
      });
      expect(logValue).toHaveBeenCalledWith(CustomMetric.WHALESYNC_RUN_NOTIFY_FAILED, 1);
      expect(logValue).toHaveBeenCalledWith(CustomMetric.WHALESYNC_RUN_NOTIFY_GAVE_UP, 1);
      expect(errorLog).toHaveBeenCalledTimes(1);
    });

    it.each([400, 413, 422])('gives up at once on a %s (Whalesync rejected the body)', async (status) => {
      const { notifier, notificationUpdateMany, logValue } = makeNotifier();
      post.mockRejectedValue(axiosHttpError(status, { message: ['workbookName must be a string'] }));
      await expect(notifier.deliverNotificationToWhalesync(queuedNotification())).resolves.toBe('gave_up');
      expect(notificationUpdateMany).toHaveBeenCalledWith({
        where: { id: 'wrn_row_1', deliveredAt: null },
        data: {
          attempts: MAX_WHALESYNC_RUN_NOTIFICATION_DELIVERY_ATTEMPTS,
          lastError: `HTTP ${status}: {"message":["workbookName must be a string"]}`,
        },
      });
      expect(logValue).toHaveBeenCalledWith(CustomMetric.WHALESYNC_RUN_NOTIFY_FAILED, 1);
      expect(logValue).toHaveBeenCalledWith(CustomMetric.WHALESYNC_RUN_NOTIFY_GAVE_UP, 1);
    });

    it('counts nothing when an overlapping sweep already delivered the row', async () => {
      const { notifier, notificationUpdateMany, logValue } = makeNotifier();
      notificationUpdateMany.mockResolvedValue({ count: 0 });
      post.mockRejectedValue(axiosHttpError(503));
      await notifier.deliverNotificationToWhalesync(queuedNotification());
      expect(logValue).not.toHaveBeenCalled();
      expect(warnLog).not.toHaveBeenCalled();
    });

    it('does not call Whalesync when it is not configured', async () => {
      const { notifier, notificationUpdateMany } = makeNotifier({ whalesyncInternalApiUrl: undefined });
      await expect(notifier.deliverNotificationToWhalesync(queuedNotification())).resolves.toBe('not_attempted');
      expect(post).not.toHaveBeenCalled();
      expect(notificationUpdateMany).not.toHaveBeenCalled();
    });

    it('never throws when recording the outcome fails', async () => {
      const { notifier, notificationUpdateMany } = makeNotifier();
      post.mockResolvedValue(whalesyncResponse(200, { outcome: 'emailed' }));
      notificationUpdateMany.mockRejectedValue(new Error('db down'));
      await expect(notifier.deliverNotificationToWhalesync(queuedNotification())).resolves.toBe('not_attempted');
      expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ routineRunId: RUN_ID }));
    });

    it('never writes the service token to a log line or to lastError', async () => {
      const { notifier, notificationUpdateMany } = makeNotifier();
      for (const requestError of [
        axiosHttpError(503),
        axiosHttpError(400),
        axiosHttpError(401),
        axiosNoResponseError('ECONNREFUSED', 'connect ECONNREFUSED 10.0.0.1:443'),
        new Error('unexpected'),
      ]) {
        post.mockRejectedValueOnce(requestError);
        await notifier.deliverNotificationToWhalesync(queuedNotification());
      }
      post.mockResolvedValueOnce(whalesyncResponse(200, { outcome: 'emailed' }));
      await notifier.deliverNotificationToWhalesync(queuedNotification());

      // A raw AxiosError serializes its request config, headers included, so this also catches one being logged.
      const everythingLoggedOrStored = JSON.stringify([
        infoLog.mock.calls,
        warnLog.mock.calls,
        errorLog.mock.calls,
        notificationUpdateMany.mock.calls,
      ]);
      expect(everythingLoggedOrStored).not.toContain(SERVICE_TOKEN);
      expect(warnLog.mock.calls.length + errorLog.mock.calls.length).toBeGreaterThan(0);
    });
  });
});
