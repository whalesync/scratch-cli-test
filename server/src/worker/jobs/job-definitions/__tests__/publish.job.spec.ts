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
      // DEV-11254: no live plan for this job id by default — i.e. a first delivery.
      findResumablePlanForJob: jest.fn().mockResolvedValue(null),
      clearOperationsForReplan: jest.fn().mockResolvedValue({ outcome: 'cleared', clearedOperationCount: 0 }),
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

  // ── DEV-11254: redelivery of a stalled self-planning job ────────────────────
  //
  // BullMQ redelivers a stalled job under its ORIGINAL id, so it re-enters `run` with the
  // same empty `pipelineId`. It used to create a SECOND plan and replan from scratch —
  // prod run `rrn_I7VfxGpZ38` stranded 47,179 successful operations that way and then died
  // replanning them. It must instead adopt the live plan it already owns.
  describe('redelivered after a stall (DEV-11254)', () => {
    const STRANDED_PLAN_ID = 'pln_stranded';

    it('adopts the live plan it already created instead of planning a second one', async () => {
      mockPublishPlanService.findResumablePlanForJob = jest
        .fn()
        .mockResolvedValue({ id: STRANDED_PLAN_ID, status: 'creates-running' });
      const params = createMockParams({ runAfterPlan: true });

      await handler.run(params);

      // Looked the plan up by the job's OWN bullJobId — the key BullMQ preserves across
      // redelivery — resolved from the DbJob row before any planning happens.
      expect(mockDbJobFindUnique).toHaveBeenCalledWith({
        where: { id: 'dbjob_123' },
        select: { bullJobId: true },
      });
      expect(mockPublishPlanService.findResumablePlanForJob).toHaveBeenCalledWith('wkb_123', SELF_PLANNED_BULL_JOB_ID);

      // The bug: neither of these may happen on a redelivery.
      expect(mockPublishPlanService.createPipeline).not.toHaveBeenCalled();
      expect(mockPublishPlanService.buildPipeline).not.toHaveBeenCalled();

      // A plan that reached a run phase keeps every operation row — those ARE the progress.
      expect(mockPublishPlanService.clearOperationsForReplan).not.toHaveBeenCalled();

      // Execution resumes against the stranded plan. runPipeline already skips
      // `status: 'success'` operations, so the completed work is not re-dispatched.
      expect(mockPublishRunService.runPipeline).toHaveBeenCalledWith(
        STRANDED_PLAN_ID,
        undefined,
        expect.any(AbortSignal),
        expect.any(Function),
        expect.any(Function),
        undefined,
      );

      const completed = checkpointedProgress(params).find((p) => p.status === 'completed');
      expect(completed?.pipelineId).toBe(STRANDED_PLAN_ID);
    });

    it('clears partial operations before replanning into a plan that died mid-build', async () => {
      // `buildPipeline` appends operations in chunks and never clears them, so a plan still
      // in `planning` holds a partial set. Replanning into it without clearing would queue
      // the same record twice in one phase — and publish it twice.
      mockPublishPlanService.findResumablePlanForJob = jest
        .fn()
        .mockResolvedValue({ id: STRANDED_PLAN_ID, status: 'planning' });
      const params = createMockParams({ runAfterPlan: false });

      await handler.run(params);

      expect(mockPublishPlanService.clearOperationsForReplan).toHaveBeenCalledWith(STRANDED_PLAN_ID);
      expect(mockPublishPlanService.createPipeline).not.toHaveBeenCalled();

      // Replans into the SAME row rather than leaking another one.
      expect(mockPublishPlanService.buildPipeline).toHaveBeenCalledWith(
        'wkb_123',
        'usr_123',
        'coa_123',
        STRANDED_PLAN_ID,
        undefined,
        undefined,
        undefined,
        expect.any(Function),
      );

      const completed = checkpointedProgress(params).find((p) => p.status === 'completed');
      expect(completed?.pipelineId).toBe(STRANDED_PLAN_ID);
    });

    it('plans fresh when the job has no live plan yet (first delivery)', async () => {
      const params = createMockParams({ runAfterPlan: false });

      await handler.run(params);

      // Consulted, found nothing, fell through to the normal self-planning path.
      expect(mockPublishPlanService.findResumablePlanForJob).toHaveBeenCalledWith('wkb_123', SELF_PLANNED_BULL_JOB_ID);
      expect(mockPublishPlanService.createPipeline).toHaveBeenCalledTimes(1);
      expect(mockPublishPlanService.clearOperationsForReplan).not.toHaveBeenCalled();
      // Still stamps the job id, which is what makes the NEXT delivery able to find it.
      expect(mockPublishPlanService.setActiveJob).toHaveBeenCalledWith(SELF_PLANNED_ID, SELF_PLANNED_BULL_JOB_ID);
    });

    it('does not consult the resume lookup when the caller supplied a pipelineId', async () => {
      // Web/CLI/desktop pre-create the plan and pass it, so the plan id already IS their
      // identity across a retry — the duplicate-PLAN bug never reached them.
      mockPublishPlanFindUnique.mockResolvedValue({ id: 'pln_existing', status: 'planning' });
      const params = createMockParams({ pipelineId: 'pln_existing', runAfterPlan: false });

      await handler.run(params);

      expect(mockPublishPlanService.findResumablePlanForJob).not.toHaveBeenCalled();
      expect(mockPublishPlanService.createPipeline).not.toHaveBeenCalled();
    });

    it('clears partial operations for a redelivered CALLER-supplied plan too', async () => {
      // Those callers were never exposed to the duplicate-plan bug, but they hit the
      // duplicate-OPERATION one identically: `buildPipeline` only flips the status off
      // `planning` at the very end, so a plan-build job that stalls partway is redelivered
      // with the same `data.pipelineId` still pointing at a `planning` row holding whatever
      // operations the first delivery flushed. Replanning without clearing publishes those
      // records twice.
      mockPublishPlanFindUnique.mockResolvedValue({ id: 'pln_existing', status: 'planning' });
      const params = createMockParams({ pipelineId: 'pln_existing', runAfterPlan: false });

      await handler.run(params);

      expect(mockPublishPlanService.clearOperationsForReplan).toHaveBeenCalledWith('pln_existing');
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
    });

    it('does not clear operations on a caller-supplied plan that already ran', async () => {
      // Past `planning` the operation rows ARE the progress and some carry `success`, so a
      // plan that reached a run phase must go straight to execution. The service would not
      // delete them even if asked — the status predicate is part of the DELETE, so it would
      // match nothing and report `plan-advanced` — but nothing is enforced by an exception
      // here, and asking would leave the resume path one bad branch away from treating a
      // mid-run plan as a raced one. The invariant is that the clear is never consulted.
      mockPublishPlanFindUnique.mockResolvedValue({ id: 'pln_existing', status: 'creates-running' });
      const params = createMockParams({ pipelineId: 'pln_existing', runAfterPlan: false });

      await handler.run(params);

      expect(mockPublishPlanService.clearOperationsForReplan).not.toHaveBeenCalled();
      expect(mockPublishPlanService.buildPipeline).not.toHaveBeenCalled();
    });

    it('leaves a missing caller-supplied pipeline for buildPipeline to report', async () => {
      // `data.pipelineId` that resolves to nothing: clearing would throw a confusing
      // "missing" error from the wrong layer. buildPipeline owns that failure.
      mockPublishPlanFindUnique.mockResolvedValue(null);
      const params = createMockParams({ pipelineId: 'pln_gone', runAfterPlan: false });

      await handler.run(params);

      expect(mockPublishPlanService.clearOperationsForReplan).not.toHaveBeenCalled();
      expect(mockPublishPlanService.buildPipeline).toHaveBeenCalledWith(
        'wkb_123',
        'usr_123',
        'coa_123',
        'pln_gone',
        undefined,
        undefined,
        undefined,
        expect.any(Function),
      );
    });

    // BullMQ redelivers a stalled job while the ORIGINAL processor may still be running —
    // `maxStalledCount: 20` exists precisely because Cloud Run causes false stall detections.
    // So this job can race the delivery that is building the very plan it wants to replan.
    it('runs the plan instead of replanning when another delivery finished the build first', async () => {
      mockPublishPlanFindUnique.mockResolvedValue({ id: 'pln_existing', status: 'planning' });
      // The other delivery flipped the plan to `planned` before our clear landed.
      mockPublishPlanService.clearOperationsForReplan = jest
        .fn()
        .mockResolvedValue({ outcome: 'plan-advanced', status: 'planned', clearedOperationCount: 0 });
      const params = createMockParams({ pipelineId: 'pln_existing', runAfterPlan: true });

      await handler.run(params);

      // Must NOT rebuild on top of a finished plan...
      expect(mockPublishPlanService.buildPipeline).not.toHaveBeenCalled();
      // ...and must NOT fail the job. Jobs are enqueued `attempts: 1`, so throwing here would
      // strand a perfectly good plan that never runs.
      expect(mockPublishRunService.runPipeline).toHaveBeenCalledWith(
        'pln_existing',
        undefined,
        expect.any(AbortSignal),
        expect.any(Function),
        expect.any(Function),
        undefined,
      );

      const completed = checkpointedProgress(params).find((p) => p.status === 'completed');
      expect(completed?.pipelineId).toBe('pln_existing');
    });

    it('cancels and fails rather than running a plan its own clear gutted', async () => {
      // The nastiest interleaving: our DELETE matched (so the plan WAS `planning`), removing
      // operations the other delivery had already built, and that delivery then flipped the
      // plan to `planned` before we re-read the status. What survives is a suffix at best.
      // Running it would publish a fraction of the records and report success.
      mockPublishPlanFindUnique.mockResolvedValue({ id: 'pln_existing', status: 'planning' });
      mockPublishPlanService.clearOperationsForReplan = jest
        .fn()
        .mockResolvedValue({ outcome: 'plan-advanced', status: 'planned', clearedOperationCount: 1200 });
      const params = createMockParams({ pipelineId: 'pln_existing', runAfterPlan: true });

      await expect(handler.run(params)).rejects.toThrow(/incomplete/);

      // Must never publish from the gutted plan.
      expect(mockPublishRunService.runPipeline).not.toHaveBeenCalled();
      // Must never report success.
      expect(checkpointedProgress(params).find((p) => p.status === 'completed')).toBeUndefined();
      // Canceled is terminal, so the resume lookup skips it and runPipeline refuses it —
      // nothing else can pick this plan up, and the next publish builds a fresh one.
      expect(mockPublishPlanService.cancelPipeline).toHaveBeenCalledWith('pln_existing');
    });

    it('falls through to buildPipeline when the plan vanished between reads', async () => {
      mockPublishPlanFindUnique.mockResolvedValue({ id: 'pln_existing', status: 'planning' });
      mockPublishPlanService.clearOperationsForReplan = jest.fn().mockResolvedValue({ outcome: 'plan-missing' });
      const params = createMockParams({ pipelineId: 'pln_existing', runAfterPlan: false });

      await handler.run(params);

      // buildPipeline owns the "pipeline not found" failure — the clear must not pre-empt it
      // with an error from the wrong layer.
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
    });
  });
});
