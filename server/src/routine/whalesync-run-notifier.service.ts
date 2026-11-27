import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, WhalesyncRunNotification, WorkbookManager } from '@prisma/client';
import {
  LIVE_EXPORT_RUN_FINISHED_NOTIFICATION_PATH,
  LIVE_EXPORT_RUN_NOTIFICATION_OUTCOMES,
  LiveExportEngine,
  liveExportRunFinishedNotificationSchema,
  RoutineRunId,
  SCRATCH_SERVICE_TOKEN_HEADER,
} from '@spinner/shared-types';
import axios, { isAxiosError } from 'axios';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { SystemFeatureFlag } from 'src/experiments/flags';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import { assertUnreachable } from 'src/utils/asserts';
import { hours, minutes, seconds } from 'src/utils/duration';

const LOG_SOURCE = 'WhalesyncRunNotifierService';

/**
 * Delivery attempts before a notification is given up on (about 5 hours of backoff). A terminal failure jumps
 * `attempts` straight to this value, so "undelivered with `attempts` at the maximum" is the single given-up state.
 */
export const MAX_WHALESYNC_RUN_NOTIFICATION_DELIVERY_ATTEMPTS = 10;

/**
 * Undelivered notifications older than this are no longer retried, e.g. ones left behind while the kill switch was
 * off. Whalesync assumes Scratch stops retrying within a day (it remembers handled runs for 7 days), and an email
 * about a day-old failure would only confuse.
 */
export const WHALESYNC_RUN_NOTIFICATION_RETRY_HORIZON = hours(24);

const WHALESYNC_RUN_NOTIFICATION_REQUEST_TIMEOUT = seconds(10);

const MAX_WHALESYNC_RUN_NOTIFICATION_RETRY_BACKOFF_MINUTES = 60;

/** Whalesync's own label for a Live Export without a name (dusky's Live Exports list), so the email matches the app. */
const UNNAMED_LIVE_EXPORT_DISPLAY_NAME = 'Untitled export';

/**
 * 4xx statuses that are not the payload's fault, so they are retried like a 5xx or a network error: an auth problem
 * (a token being rotated or not yet deployed), a missing route (bottlenose not deployed yet, or reverted), a request
 * timeout, and rate limiting. Every other 4xx means Whalesync rejected the body itself, which retrying can't fix.
 */
const RETRYABLE_CLIENT_ERROR_HTTP_STATUSES = new Set([401, 403, 404, 408, 429]);

const MAX_LAST_ERROR_LENGTH = 1000;

/** What one POST to Whalesync came to. */
type WhalesyncRunNotificationDeliveryAttemptResult =
  | { kind: 'delivered'; outcome: string }
  | { kind: 'retryable_failure'; reason: string }
  | { kind: 'terminal_failure'; reason: string };

/** Where a notification stands after {@link WhalesyncRunNotifierService.deliverNotificationToWhalesync}. */
export type WhalesyncRunNotificationDeliveryStatus = 'delivered' | 'will_retry' | 'gave_up' | 'not_attempted';

/**
 * Tells Whalesync about failed Live Export runs so it can email the export's owner (DEV-12330, Whalesync side
 * DEV-11416). Live Export run state lives only in Scratch, so this is the only way Whalesync learns a run failed.
 *
 * Built as an outbox. When a `ws_export` run fails, the routine executor calls {@link enqueueForRun}, which only writes
 * a `WhalesyncRunNotification` row. The `WhalesyncRunNotificationSweeperService` cron then sends every row, one at a
 * time from the cron service, and retries with backoff. That keeps HTTP out of the executor (which may run on the API
 * service, whose CPU is throttled outside requests) and serializes the POSTs, so Whalesync's per-user daily throttle
 * sees one failure before the next. Whalesync dedupes by run id, so a repeated delivery is harmless.
 *
 * Everything is off unless `WHALESYNC_INTERNAL_API_URL` and `WHALESYNC_SERVICE_TOKEN` are set and the
 * `LIVE_EXPORT_RUN_NOTIFY_WHALESYNC_ENABLED` flag is on.
 */
@Injectable()
export class WhalesyncRunNotifierService implements OnModuleInit {
  constructor(
    private readonly db: DbService,
    private readonly configService: ScratchConfigService,
    private readonly experimentsService: ExperimentsService,
    @Inject(CustomMetricsService) private readonly metricsService: CustomMetricsService,
  ) {}

  onModuleInit(): void {
    if (!this.getWhalesyncNotificationEndpoint()) {
      WSLogger.info({
        source: LOG_SOURCE,
        message:
          'Whalesync run notifications are off on this instance: WHALESYNC_INTERNAL_API_URL or WHALESYNC_SERVICE_TOKEN is not set',
      });
    }
  }

  /** Whether failed Live Export runs should be queued and sent to Whalesync right now (config set and flag on). */
  async isNotificationDeliveryEnabled(): Promise<boolean> {
    // Check the config first so an unconfigured environment never calls PostHog.
    if (!this.getWhalesyncNotificationEndpoint()) {
      return false;
    }
    return this.experimentsService.getBooleanFlag(SystemFeatureFlag.LIVE_EXPORT_RUN_NOTIFY_WHALESYNC_ENABLED, false);
  }

  /**
   * The routine executor's hook, called once when a run transitions to `failed`. Queues the run for Whalesync when it
   * is a Live Export whose user belongs to a Whalesync team, and does nothing otherwise. Never throws and makes no
   * HTTP call; the sweeper cron delivers the queued row.
   */
  async enqueueForRun(runId: RoutineRunId): Promise<void> {
    try {
      if (!(await this.isNotificationDeliveryEnabled())) {
        return;
      }
      await this.enqueueNotificationIfRunIsEligible(runId);
    } catch (error) {
      WSLogger.error({
        source: LOG_SOURCE,
        message: `Failed to queue the Whalesync notification for routine run ${runId}`,
        routineRunId: runId,
        error,
      });
    }
  }

  /**
   * Queues a `WhalesyncRunNotification` for the run when it is a failed Live Export (`ws_export`) run whose workbook
   * belongs to a Whalesync team and is not being deleted. Returns true when it queued a deliverable notification, and false
   * when the run isn't eligible or already has one. Shared by the executor's hook and the sweeper's backfill.
   */
  async enqueueNotificationIfRunIsEligible(runId: RoutineRunId): Promise<boolean> {
    const run = await this.db.client.routineRun.findUnique({
      where: { id: runId },
      select: {
        id: true,
        workbookId: true,
        routineFilePath: true,
        status: true,
        trigger: true,
        finishedAt: true,
        resultSummary: true,
        resultWarning: true,
        error: true,
        liveExportEngine: true,
        workbook: {
          select: {
            name: true,
            managedBy: true,
            isPendingDelete: true,
            user: { select: { whalesyncTeamId: true } },
          },
        },
      },
    });
    if (!run || run.status !== 'failed' || run.workbook.managedBy !== WorkbookManager.ws_export) {
      return false;
    }
    if (run.workbook.isPendingDelete) {
      // Deleting a Live Export mid-run fails the run ("Workbook not found"); don't email about an export the user
      // just deleted.
      return false;
    }
    // The workbook's shadow user holds the Live Exports of one Whalesync team (DEV-13019), which is who Whalesync
    // tells. A workbook whose user belongs to no team has nobody to tell.
    const whalesyncTeamId = run.workbook.user?.whalesyncTeamId;
    if (!whalesyncTeamId) {
      WSLogger.info({
        source: LOG_SOURCE,
        message: `Not notifying Whalesync about failed Live Export run ${run.id}: its workbook's user belongs to no Whalesync team`,
        routineRunId: run.id,
        workbookId: run.workbookId,
      });
      return false;
    }

    const unvalidatedNotificationPayload = {
      whalesyncTeamId,
      workbookId: run.workbookId,
      workbookName: run.workbook.name ?? UNNAMED_LIVE_EXPORT_DISPLAY_NAME,
      routineFilePath: run.routineFilePath,
      runId: run.id,
      status: run.status,
      trigger: run.trigger,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      resultSummary: run.resultSummary,
      resultWarning: run.resultWarning,
      error: run.error,
      // Informational only, so an engine this contract doesn't know yet is sent as null rather than failing the email.
      liveExportEngine: Object.values(LiveExportEngine).find((engine) => engine === run.liveExportEngine) ?? null,
    };
    const validatedNotificationPayload =
      liveExportRunFinishedNotificationSchema.safeParse(unvalidatedNotificationPayload);

    try {
      if (validatedNotificationPayload.success) {
        await this.db.client.whalesyncRunNotification.create({
          data: { routineRunId: run.id, workbookId: run.workbookId, payload: validatedNotificationPayload.data },
        });
        return true;
      }

      // A payload Whalesync would reject can never be delivered. Record it as given up (so the backfill doesn't
      // queue the run again) instead of sending it.
      const validationIssues = validatedNotificationPayload.error.issues
        .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
        .join('; ');
      await this.db.client.whalesyncRunNotification.create({
        data: {
          routineRunId: run.id,
          workbookId: run.workbookId,
          payload: unvalidatedNotificationPayload,
          attempts: MAX_WHALESYNC_RUN_NOTIFICATION_DELIVERY_ATTEMPTS,
          lastError: truncateForLastError(`Invalid notification payload: ${validationIssues}`),
        },
      });
      this.metricsService.logValue(CustomMetric.WHALESYNC_RUN_NOTIFY_GAVE_UP, 1);
      WSLogger.error({
        source: LOG_SOURCE,
        message: `Not notifying Whalesync about failed Live Export run ${run.id}: the payload is invalid (${validationIssues})`,
        routineRunId: run.id,
        workbookId: run.workbookId,
      });
      return false;
    } catch (error) {
      // P2002: the run already has a notification (the hook and the backfill raced). P2003: the run was deleted
      // between the read and the insert. Neither needs a notification from this call.
      if (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2002' || error.code === 'P2003')) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Sends one queued notification to Whalesync and records the outcome on its row: delivered on a 2xx carrying an
   * outcome, rescheduled with backoff on a retryable failure, or given up on (a terminal 4xx, or out of attempts).
   * Never throws. Called by the sweeper cron, one notification at a time.
   */
  async deliverNotificationToWhalesync(
    notification: WhalesyncRunNotification,
  ): Promise<WhalesyncRunNotificationDeliveryStatus> {
    try {
      const endpoint = this.getWhalesyncNotificationEndpoint();
      if (!endpoint) {
        return 'not_attempted';
      }
      const deliveryAttemptResult = await postNotificationToWhalesync(endpoint, notification.payload);
      return await this.recordDeliveryAttemptResult(notification, deliveryAttemptResult);
    } catch (error) {
      // Only the bookkeeping writes can throw here: postNotificationToWhalesync turns every request error into a
      // result, and its errors must never be logged raw (an AxiosError carries the request headers, token included).
      WSLogger.error({
        source: LOG_SOURCE,
        message: `Failed to record the Whalesync delivery attempt for routine run ${notification.routineRunId}`,
        notificationId: notification.id,
        routineRunId: notification.routineRunId,
        error,
      });
      return 'not_attempted';
    }
  }

  private async recordDeliveryAttemptResult(
    notification: WhalesyncRunNotification,
    deliveryAttemptResult: WhalesyncRunNotificationDeliveryAttemptResult,
  ): Promise<WhalesyncRunNotificationDeliveryStatus> {
    const notificationLogFields = {
      source: LOG_SOURCE,
      notificationId: notification.id,
      routineRunId: notification.routineRunId,
      workbookId: notification.workbookId,
    };

    switch (deliveryAttemptResult.kind) {
      case 'delivered': {
        const recorded = await this.updateNotificationIfStillUndelivered(notification.id, {
          deliveredAt: new Date(),
          lastError: null,
        });
        if (!recorded) {
          return 'delivered';
        }
        this.metricsService.logValue(CustomMetric.WHALESYNC_RUN_NOTIFY_SENT, 1);
        const outcomeIsKnown = (LIVE_EXPORT_RUN_NOTIFICATION_OUTCOMES as readonly string[]).includes(
          deliveryAttemptResult.outcome,
        );
        const deliveredLogFields = {
          ...notificationLogFields,
          message: `Delivered the failed Live Export run ${notification.routineRunId} to Whalesync (outcome: ${deliveryAttemptResult.outcome})`,
          outcome: deliveryAttemptResult.outcome,
        };
        if (outcomeIsKnown) {
          WSLogger.info(deliveredLogFields);
        } else {
          // Still delivered (any 2xx with an outcome is), but the contract has moved on without us.
          WSLogger.warn(deliveredLogFields);
        }
        return 'delivered';
      }
      case 'retryable_failure': {
        const failedAttempts = notification.attempts + 1;
        const lastError = truncateForLastError(deliveryAttemptResult.reason);
        if (failedAttempts >= MAX_WHALESYNC_RUN_NOTIFICATION_DELIVERY_ATTEMPTS) {
          const recorded = await this.updateNotificationIfStillUndelivered(notification.id, {
            attempts: MAX_WHALESYNC_RUN_NOTIFICATION_DELIVERY_ATTEMPTS,
            lastError,
          });
          if (recorded) {
            this.metricsService.logValue(CustomMetric.WHALESYNC_RUN_NOTIFY_FAILED, 1);
            this.metricsService.logValue(CustomMetric.WHALESYNC_RUN_NOTIFY_GAVE_UP, 1);
            WSLogger.error({
              ...notificationLogFields,
              message: `Gave up notifying Whalesync about failed Live Export run ${notification.routineRunId} after ${failedAttempts} attempts: ${lastError}`,
            });
          }
          return 'gave_up';
        }
        const retryBackoffMinutes = whalesyncRunNotificationRetryBackoffMinutes(failedAttempts);
        const recorded = await this.updateNotificationIfStillUndelivered(notification.id, {
          attempts: failedAttempts,
          nextAttemptAt: minutes(retryBackoffMinutes).inFuture(),
          lastError,
        });
        if (recorded) {
          this.metricsService.logValue(CustomMetric.WHALESYNC_RUN_NOTIFY_FAILED, 1);
          WSLogger.warn({
            ...notificationLogFields,
            message: `Failed to notify Whalesync about failed Live Export run ${notification.routineRunId} (attempt ${failedAttempts}); retrying in ${retryBackoffMinutes} min: ${lastError}`,
          });
        }
        return 'will_retry';
      }
      case 'terminal_failure': {
        const lastError = truncateForLastError(deliveryAttemptResult.reason);
        const recorded = await this.updateNotificationIfStillUndelivered(notification.id, {
          attempts: MAX_WHALESYNC_RUN_NOTIFICATION_DELIVERY_ATTEMPTS,
          lastError,
        });
        if (recorded) {
          this.metricsService.logValue(CustomMetric.WHALESYNC_RUN_NOTIFY_FAILED, 1);
          this.metricsService.logValue(CustomMetric.WHALESYNC_RUN_NOTIFY_GAVE_UP, 1);
          WSLogger.error({
            ...notificationLogFields,
            message: `Whalesync rejected the notification for failed Live Export run ${notification.routineRunId}; not retrying: ${lastError}`,
          });
        }
        return 'gave_up';
      }
      default:
        return assertUnreachable(deliveryAttemptResult);
    }
  }

  /**
   * Writes a delivery outcome unless the row was already delivered (by an overlapping sweep during a deploy), so a
   * late failure can't overwrite a success. Returns whether this call recorded it.
   */
  private async updateNotificationIfStillUndelivered(
    notificationId: string,
    data: Prisma.WhalesyncRunNotificationUpdateManyMutationInput,
  ): Promise<boolean> {
    const { count } = await this.db.client.whalesyncRunNotification.updateMany({
      where: { id: notificationId, deliveredAt: null },
      data,
    });
    return count === 1;
  }

  /** The full notification URL and the service token, or null when either is not configured. */
  private getWhalesyncNotificationEndpoint(): { url: string; serviceToken: string } | null {
    const whalesyncInternalApiUrl = this.configService.getWhalesyncInternalApiUrl();
    const serviceToken = this.configService.getWhalesyncServiceToken();
    if (!whalesyncInternalApiUrl || !serviceToken) {
      return null;
    }
    return { url: `${whalesyncInternalApiUrl}${LIVE_EXPORT_RUN_FINISHED_NOTIFICATION_PATH}`, serviceToken };
  }
}

/** Minutes to wait before retrying after `failedAttempts` failures: 2, 4, 8, 16, 32, then hourly. */
export function whalesyncRunNotificationRetryBackoffMinutes(failedAttempts: number): number {
  return Math.min(2 ** failedAttempts, MAX_WHALESYNC_RUN_NOTIFICATION_RETRY_BACKOFF_MINUTES);
}

/**
 * POSTs the stored payload and classifies the response. Never throws, and never lets the raw AxiosError escape: it
 * carries the request config, service token included, and the logger serializes errors' own properties.
 */
async function postNotificationToWhalesync(
  endpoint: { url: string; serviceToken: string },
  notificationPayload: Prisma.JsonValue,
): Promise<WhalesyncRunNotificationDeliveryAttemptResult> {
  try {
    const response = await axios.post<unknown>(endpoint.url, notificationPayload, {
      timeout: WHALESYNC_RUN_NOTIFICATION_REQUEST_TIMEOUT.ms(),
      // A redirect would turn the POST into a GET; treat it as a (retryable) misconfiguration instead.
      maxRedirects: 0,
      headers: { [SCRATCH_SERVICE_TOKEN_HEADER]: endpoint.serviceToken },
    });
    const outcome = outcomeFromWhalesyncResponseBody(response.data);
    if (outcome === null) {
      // Whalesync always answers with an outcome, so a bare 2xx most likely came from something else at that URL.
      return {
        kind: 'retryable_failure',
        reason: `HTTP ${response.status} without an outcome (is WHALESYNC_INTERNAL_API_URL right?): ${describeResponseBodyForLastError(response.data)}`,
      };
    }
    return { kind: 'delivered', outcome };
  } catch (error) {
    return classifyFailedWhalesyncRequest(error);
  }
}

function classifyFailedWhalesyncRequest(error: unknown): WhalesyncRunNotificationDeliveryAttemptResult {
  if (!isAxiosError(error)) {
    return { kind: 'retryable_failure', reason: error instanceof Error ? error.message : String(error) };
  }
  const responseStatus = error.response?.status;
  if (responseStatus === undefined) {
    // No response at all: a network error or the request timed out.
    return { kind: 'retryable_failure', reason: error.code ? `${error.code}: ${error.message}` : error.message };
  }
  const reason = `HTTP ${responseStatus}: ${describeResponseBodyForLastError(error.response?.data)}`;
  const isTerminal =
    responseStatus >= 400 && responseStatus < 500 && !RETRYABLE_CLIENT_ERROR_HTTP_STATUSES.has(responseStatus);
  return isTerminal ? { kind: 'terminal_failure', reason } : { kind: 'retryable_failure', reason };
}

function outcomeFromWhalesyncResponseBody(responseBody: unknown): string | null {
  if (typeof responseBody !== 'object' || responseBody === null || !('outcome' in responseBody)) {
    return null;
  }
  const { outcome } = responseBody;
  return typeof outcome === 'string' && outcome !== '' ? outcome : null;
}

function describeResponseBodyForLastError(responseBody: unknown): string {
  if (responseBody === undefined || responseBody === null || responseBody === '') {
    return '(empty body)';
  }
  return typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody);
}

function truncateForLastError(message: string): string {
  return message.length > MAX_LAST_ERROR_LENGTH ? `${message.slice(0, MAX_LAST_ERROR_LENGTH)}…` : message;
}
