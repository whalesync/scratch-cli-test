import type { PrismaClient } from '@prisma/client';
import type { DiscardPendingChangesPublicProgress, WorkbookId } from '@spinner/shared-types';
import { type JobTrigger, JobType } from '@spinner/shared-types';
import { UserCluster } from 'src/db/cluster-types';
import { WorkbookEventService } from 'src/workbook/workbook-event.service';
import { WorkbookService } from 'src/workbook/workbook.service';
import { WSLogger } from '../../../logger';
import { Actor, userToActor } from '../../../users/types';
import type { JobDefinitionBuilder, JobHandlerBuilder, Progress } from '../base-types';

// `DiscardPendingChangesPublicProgress` lives in `@spinner/shared-types` so the web client, desktop
// app, and CLI render it without a shadow copy. Re-exported here for symmetry with the other job
// handlers (which re-export the progress type they implement).
export type { DiscardPendingChangesPublicProgress };

export type DiscardPendingChangesJobDefinition = JobDefinitionBuilder<
  typeof JobType.DiscardPendingChanges,
  {
    workbookId: WorkbookId;
    userId: string;
    organizationId: string;
    trigger?: JobTrigger;
    initialPublicProgress?: DiscardPendingChangesPublicProgress;
  },
  DiscardPendingChangesPublicProgress,
  Record<string, never>, // jobProgress — no internal checkpoint state
  void
>;

/**
 * Pre-flight cleanup job for a routine run: discards every connection's leftover working-set edits so
 * the pull → sync → publish that follows starts from the published baseline (no stray, never-published
 * edit can pollute it). Reports what it cleared — counts and filenames, per connection — through the
 * standard `publicProgress` so the run-step detail can show it. Delegates the actual work to
 * {@link WorkbookService.discardAllPendingChangesWithStats}, which is idempotent, so a retried routine
 * re-runs this harmlessly.
 */
export class DiscardPendingChangesJobHandler implements JobHandlerBuilder<DiscardPendingChangesJobDefinition> {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly workbookService: WorkbookService,
    private readonly workbookEventService: WorkbookEventService,
  ) {}

  async run(params: {
    jobId: string;
    data: DiscardPendingChangesJobDefinition['data'];
    progress: Progress<
      DiscardPendingChangesJobDefinition['publicProgress'],
      DiscardPendingChangesJobDefinition['initialJobProgress']
    >;
    abortSignal: AbortSignal;
    checkpoint: (
      progress: Omit<
        Progress<
          DiscardPendingChangesJobDefinition['publicProgress'],
          DiscardPendingChangesJobDefinition['initialJobProgress']
        >,
        'timestamp'
      >,
    ) => Promise<void>;
  }) {
    const { jobId, data, checkpoint } = params;

    WSLogger.info({
      source: 'DiscardPendingChangesJob',
      message: 'Starting pre-flight discard of pending changes',
      workbookId: data.workbookId,
      jobId,
    });

    this.workbookEventService.sendWorkbookEvent(data.workbookId, {
      type: 'job-started',
      data: {
        source: 'job',
        entityId: data.workbookId,
        message: 'Preparing workspace for sync',
        jobId,
      },
    });

    await checkpoint({
      publicProgress: { status: 'active', totalDiscarded: 0, connections: [] },
      jobProgress: {},
      connectorProgress: {},
    });

    // Reload the user to populate workspacePermissions on the actor — the queue payload only carries
    // userId/organizationId, but discardAllPendingChangesWithStats resolves the workbook through the
    // permission-checked findOneOrThrow, which requires the permissions list.
    const user = await this.prisma.user.findUnique({
      where: { id: data.userId },
      include: UserCluster._validator.include,
    });
    if (!user) {
      throw new Error(`User ${data.userId} not found`);
    }
    const actor: Actor = userToActor(user);

    try {
      const result = await this.workbookService.discardAllPendingChangesWithStats(data.workbookId, actor);

      const connections: DiscardPendingChangesPublicProgress['connections'] = result.connections.map((connection) => ({
        connectorAccountId: connection.connectorAccountId,
        connectionName: connection.connectionName,
        connector: connection.connector,
        addedCount: connection.addedCount,
        modifiedCount: connection.modifiedCount,
        deletedCount: connection.deletedCount,
        addedPaths: connection.addedPaths,
        modifiedPaths: connection.modifiedPaths,
        deletedPaths: connection.deletedPaths,
      }));

      await checkpoint({
        publicProgress: { status: 'completed', totalDiscarded: result.totalDiscarded, connections },
        jobProgress: {},
        connectorProgress: {},
      });

      this.workbookEventService.sendWorkbookEvent(data.workbookId, {
        type: 'job-completed',
        data: {
          source: 'job',
          entityId: data.workbookId,
          message:
            result.totalDiscarded === 0
              ? 'Workspace ready for sync'
              : `Cleared ${result.totalDiscarded} leftover change(s) before sync`,
          jobId,
        },
      });

      WSLogger.info({
        source: 'DiscardPendingChangesJob',
        message: 'Completed pre-flight discard of pending changes',
        workbookId: data.workbookId,
        jobId,
        totalDiscarded: result.totalDiscarded,
        connectionsCleared: result.connections.length,
      });
    } catch (err) {
      await checkpoint({
        publicProgress: { status: 'failed', totalDiscarded: 0, connections: [] },
        jobProgress: {},
        connectorProgress: {},
      });
      throw err;
    }
  }
}
