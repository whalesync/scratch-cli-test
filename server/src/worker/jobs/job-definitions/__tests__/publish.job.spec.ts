/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import { JobType, WorkbookId } from '@spinner/shared-types';
import { DbService } from '../../../../db/db.service';
import { PostHogService } from '../../../../posthog/posthog.service';
import { PublishPlanBuildService } from '../../../../publish-plan/publish-plan-build.service';
import { PublishPlanRunService } from '../../../../publish-plan/publish-plan-run.service';
import { WorkbookEventService } from '../../../../workbook/workbook-event.service';
import { JobCanceledError } from '../../../../worker/job-errors';
import { PublishJobDefinition, PublishJobHandler, PublishPublicProgress } from '../publish.job';

describe('PublishJobHandler — self-planning publish (DEV-10436)', () => {
  let handler: PublishJobHandler;
  let mockPublishPlanService: jest.Mocked<PublishPlanBuildService>;
  let mockPublishRunService: jest.Mocked<PublishPlanRunService>;
  let mockDb: jest.Mocked<DbService>;
  // Captured Prisma client method mocks (the DbService.client type isn't deep-mocked, so
  // hold the jest.fn()s directly to stub return values and assert calls).
  let mockPublishPlanFindUnique: jest.Mock;
  let mockDbJobFindUnique: jest.Mock;
  let mockWorkbookEventService: jest.Mocked<WorkbookEventService>;
  let mockPostHogService: jest.Mocked<PostHogService>;

  const SELF_PLANNED_ID = 'pln_new';
  const SELF_PLANNED_BULL_JOB_ID = 'publish-wkb_123-abc';

  const zeroPublicProgress: PublishPublicProgress = {
    status: 'planning',
    assetUploadsExecuted: 0,
    assetUploadsPlanned: 0,
    editsExecuted: 0,
    createsExecuted: 0,
    deletesExecuted: 0,
    backfillsExecuted: 0,
    renameFilesExecuted: 0,
    editsPlanned: 0,
    createsPlanned: 0,
    deletesPlanned: 0,
    backfillsPlanned: 0,
    renameFilesPlanned: 0,
    errorCount: 0,
  };

  const createMockParams = (dataOverrides?: Partial<PublishJobDefinition['data']>) => ({
    jobId: 'dbjob_123',
    data: {
      type: JobType.Publish,
      workbookId: 'wkb_123' as WorkbookId,
      userId: 'usr_123',
      connectorAccountId: 'coa_123',
      ...dataOverrides,
    } as PublishJobDefinition['data'],
    progress: {
      publicProgress: zeroPublicProgress,
      jobProgress: {},
      connectorProgress: {},
      timestamp: Date.now(),
    },
    abortSignal: new AbortController().signal,
    checkpoint: jest.fn().mockResolvedValue(undefined),
  });

  // Pull every checkpointed publicProgress out of a params' checkpoint mock so tests can
  // assert what was surfaced (e.g. the resolved pipelineId on the terminal checkpoint).
  const checkpointedProgress = (params: ReturnType<typeof createMockParams>): PublishPublicProgress[] => {
    const calls = params.checkpoint.mock.calls as unknown as Array<[{ publicProgress: PublishPublicProgress }]>;
    return calls.map((call) => call[0].publicProgress);
  };

  beforeEach(() => {
    mockPublishPlanService = {
      createPipeline: jest
        .fn()
        .mockResolvedValue({ pipelineId: SELF_PLANNED_ID, branchName: `publish/usr_123/${SELF_PLANNED_ID}` }),
      // Echo the 4th arg (existingPipelineId) back as the resolved id so tests can verify
      // which pipeline the plan was built against; fall back to a sentinel if none passed.
      buildPipeline: jest
        .fn()
        .mockImplementation((_wb, _u, _ca, existingPipelineId) =>
          Promise.resolve({ pipelineId: existingPipelineId ?? 'pln_built_inline' }),
        ),
      setActiveJob: jest.fn().mockResolvedValue(undefined),
      cancelPipeline: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<PublishPlanBuildService>;

    mockPublishRunService = {
      runPipeline: jest.fn().mockResolvedValue({
        successByPhase: {},
        totalByPhase: {},
        failedCount: 0,
        failedOperations: [],
      }),
    } as unknown as jest.Mocked<PublishPlanRunService>;

    mockPublishPlanFindUnique = jest.fn();
    mockDbJobFindUnique = jest.fn().mockResolvedValue({ bullJobId: SELF_PLANNED_BULL_JOB_ID });
    mockDb = {
      client: {
        publishPlan: { findUnique: mockPublishPlanFindUnique },
        publishPlanOperation: { count: jest.fn().mockResolvedValue(0) },
        dbJob: { findUnique: mockDbJobFindUnique },
      },
    } as unknown as jest.Mocked<DbService>;

    mockWorkbookEventService = {
      sendWorkbookEvent: jest.fn(),
    } as unknown as jest.Mocked<WorkbookEventService>;

    mockPostHogService = {
      trackPublishCompleted: jest.fn(),
      trackPublishAbortedDirtyDrift: jest.fn(),
    } as unknown as jest.Mocked<PostHogService>;

    handler = new PublishJobHandler(
      mockPublishPlanService,
      mockPublishRunService,
      mockDb,
      mockWorkbookEventService,
      undefined,
      mockPostHogService,
    );
  });

  it('creates its own pipeline, links the job, and stops after planning when runAfterPlan is false', async () => {
    const params = createMockParams({ runAfterPlan: false });

    await handler.run(params);

    // createPipeline called with (workbookId, userId, connectorAccountId)
    expect(mockPublishPlanService.createPipeline).toHaveBeenCalledTimes(1);
    expect(mockPublishPlanService.createPipeline).toHaveBeenCalledWith('wkb_123', 'usr_123', 'coa_123');

    // Resolves its own bullJobId from the DbJob row (params.jobId is the DbJob id) and
    // links the pipeline to it.
    expect(mockDbJobFindUnique).toHaveBeenCalledWith({
      where: { id: 'dbjob_123' },
      select: { bullJobId: true },
    });
    expect(mockPublishPlanService.setActiveJob).toHaveBeenCalledWith(SELF_PLANNED_ID, SELF_PLANNED_BULL_JOB_ID);

    // Builds the plan against the self-created id (4th positional arg).
    expect(mockPublishPlanService.buildPipeline).toHaveBeenCalledWith(
      'wkb_123',
      'usr_123',
      'coa_123',
      SELF_PLANNED_ID,
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    );

    // Plan-only: never runs the pipeline.
    expect(mockPublishRunService.runPipeline).not.toHaveBeenCalled();

    // Terminal completed checkpoint surfaces the resolved pipelineId.
    const completed = checkpointedProgress(params).find((p) => p.status === 'completed');
    expect(completed?.pipelineId).toBe(SELF_PLANNED_ID);
  });

  it('creates its own pipeline and runs it when runAfterPlan is true', async () => {
    const params = createMockParams({ runAfterPlan: true });

    await handler.run(params);

    expect(mockPublishPlanService.createPipeline).toHaveBeenCalledTimes(1);
    expect(mockPublishPlanService.setActiveJob).toHaveBeenCalledWith(SELF_PLANNED_ID, SELF_PLANNED_BULL_JOB_ID);
    expect(mockPublishRunService.runPipeline).toHaveBeenCalledWith(
      SELF_PLANNED_ID,
      undefined,
      expect.any(AbortSignal),
      expect.any(Function),
      expect.any(Function),
      // DEV-10048: publishOrigin — undefined here (this self-planning job sets none).
      undefined,
    );

    const completed = checkpointedProgress(params).find((p) => p.status === 'completed');
    expect(completed?.pipelineId).toBe(SELF_PLANNED_ID);
    expect(completed?.failedCount).toBe(0);
  });

  it('leaves the existing-pipeline path unchanged when a pipelineId is provided', async () => {
    mockPublishPlanFindUnique.mockResolvedValue({ id: 'pln_existing', status: 'planning' });
    const params = createMockParams({ pipelineId: 'pln_existing', runAfterPlan: false });

    await handler.run(params);

    // No self-planning: the caller already owns createPipeline/setActiveJob.
    expect(mockPublishPlanService.createPipeline).not.toHaveBeenCalled();
    expect(mockPublishPlanService.setActiveJob).not.toHaveBeenCalled();
    expect(mockDbJobFindUnique).not.toHaveBeenCalled();

    // Plan is built against the caller's id.
    expect(mockPublishPlanService.buildPipeline).toHaveBeenCalledWith(
      'wkb_123',
      'usr_123',
      'coa_123',
      'pln_existing',
      undefined,
      undefined,
      undefined,
      expect.any(Function),
    );

    const completed = checkpointedProgress(params).find((p) => p.status === 'completed');
    expect(completed?.pipelineId).toBe('pln_existing');
  });

  it('skips replanning when the provided pipeline is already planned', async () => {
    mockPublishPlanFindUnique.mockResolvedValue({ id: 'pln_existing', status: 'completed' });
    const params = createMockParams({ pipelineId: 'pln_existing', runAfterPlan: false });

    await handler.run(params);

    expect(mockPublishPlanService.createPipeline).not.toHaveBeenCalled();
    expect(mockPublishPlanService.buildPipeline).not.toHaveBeenCalled();

    const completed = checkpointedProgress(params).find((p) => p.status === 'completed');
    expect(completed?.pipelineId).toBe('pln_existing');
  });

  it('cancels the self-created pipeline if planning is canceled', async () => {
    mockPublishPlanService.buildPipeline.mockRejectedValueOnce(new JobCanceledError('dbjob_123'));
    const params = createMockParams({ runAfterPlan: false });

    await expect(handler.run(params)).rejects.toThrow(JobCanceledError);

    // The catch cancels the resolved (self-created) id, not data.pipelineId (which is empty).
    expect(mockPublishPlanService.cancelPipeline).toHaveBeenCalledWith(SELF_PLANNED_ID);
  });

  it('does not cancel a pipeline when the cancel happens before one is created', async () => {
    // Cancel during createPipeline itself: pipelineId is never assigned, so the guarded
    // cancel must be a no-op rather than calling cancelPipeline(undefined).
    mockPublishPlanService.createPipeline.mockRejectedValueOnce(new JobCanceledError('dbjob_123'));
    const params = createMockParams({ runAfterPlan: false });

    await expect(handler.run(params)).rejects.toThrow(JobCanceledError);

    expect(mockPublishPlanService.cancelPipeline).not.toHaveBeenCalled();
  });
});
