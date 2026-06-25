/* eslint-disable @typescript-eslint/require-await */
import { ConflictException } from '@nestjs/common';
import { Prisma, type DbJob } from '@prisma/client';
import { RoutineAction, RoutineRunId, RoutineStepOptions, WorkbookId } from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { DbService } from 'src/db/db.service';
import { JobService } from 'src/job/job.service';
import { RunCountService } from 'src/run-count/run-count.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { BullEnqueuerService } from 'src/worker-enqueuer/bull-enqueuer.service';
import { RoutineExecutorService } from '../routine-executor.service';
import { RoutineParserService } from '../routine-parser.service';
import { RoutineReferenceValidatorService } from '../routine-reference-validator.service';
import { RoutineValidationContext } from '../routine.types';

const WORKBOOK_ID = 'wkb_test1234' as WorkbookId;
const RUN_ID = 'rrn_test1234' as RoutineRunId;

interface FakeRun {
  id: string;
  workbookId: string;
  status: string;
  trigger: string;
  triggeredByUserId: string | null;
  currentStepIndex: number;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
  resultSummary: string | null;
  resultWarning: string | null;
  routineFilePath: string;
  routineName: string;
}

interface FakeStep {
  id: string;
  runId: string;
  stepIndex: number;
  action: string;
  name: string | null;
  folder: string | null;
  folders: string[];
  connection: string | null;
  sync: string | null;
  timeoutSeconds: number | null;
  options: RoutineStepOptions | null;
  status: string;
  jobId: string | null;
  pipelineId: string | null;
  error: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
}

/** A linked folder so a `pull`/`publish` step has something to resolve against. */
function singleFolderContext(): RoutineValidationContext {
  return {
    foldersByPath: new Map([['blog/posts', [{ id: 'dfd_1', path: 'blog/posts', connectorAccountId: 'coa_1' }]]]),
    foldersById: new Map([['dfd_1', { id: 'dfd_1', path: 'blog/posts', connectorAccountId: 'coa_1' }]]),
    connectionsByName: new Map([['airtable', { id: 'coa_1', displayName: 'Airtable' }]]),
    connectionsById: new Map([['coa_1', { id: 'coa_1', displayName: 'Airtable' }]]),
    syncsById: new Map([['syn_1', { id: 'syn_1', displayName: 'Blog Sync' }]]),
  };
}

function makeStep(index: number, action: RoutineAction, overrides: Partial<FakeStep> = {}): FakeStep {
  return {
    id: `rrs_${index}`,
    runId: RUN_ID,
    stepIndex: index,
    action,
    name: null,
    folder: null,
    folders: [],
    connection: null,
    sync: action === RoutineAction.SYNC ? 'syn_1' : null,
    timeoutSeconds: null,
    options: null,
    status: 'pending',
    jobId: null,
    pipelineId: null,
    error: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

/**
 * A tiny stateful in-memory stand-in for the Prisma client, tailored to the queries the executor's
 * `execute()` makes. It lets the run/step state actually transition so the loop's advance/skip/finalize
 * behaviour is exercised, not just asserted call-by-call.
 */
function makeFakeDb(run: FakeRun, steps: FakeStep[]) {
  const matchesRunStatus = (where: { status?: unknown }): boolean => {
    if (!where.status) return true;
    if (typeof where.status === 'string') return run.status === where.status;
    const inList = (where.status as { in?: string[] }).in;
    return inList ? inList.includes(run.status) : true;
  };

  const client = {
    routineRun: {
      updateMany: jest.fn(
        async ({ where, data }: { where: { id: string; status?: unknown }; data: Partial<FakeRun> }) => {
          if (where.id !== run.id || !matchesRunStatus(where)) return { count: 0 };
          Object.assign(run, data);
          return { count: 1 };
        },
      ),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => (where.id === run.id ? { ...run } : null)),
      update: jest.fn(async ({ data }: { data: Partial<FakeRun> }) => {
        Object.assign(run, data);
        return { ...run };
      }),
    },
    routineRunStep: {
      findMany: jest.fn(async () => steps.map((step) => ({ ...step })).sort((a, b) => a.stepIndex - b.stepIndex)),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const step = steps.find((candidate) => candidate.id === where.id);
        return step ? { ...step } : null;
      }),
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { runId?: string; status?: string; error?: { not: null } };
          orderBy?: { stepIndex: 'asc' | 'desc' };
        }) => {
          const match = [...steps]
            .sort((a, b) => a.stepIndex - b.stepIndex)
            .find((step) => {
              if (where.runId && step.runId !== where.runId) return false;
              if (where.status && step.status !== where.status) return false;
              if (where.error?.not === null && step.error == null) return false;
              return true;
            });
          return match ? { ...match } : null;
        },
      ),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeStep> }) => {
        const step = steps.find((candidate) => candidate.id === where.id);
        if (step) Object.assign(step, data);
        return step ? { ...step } : null;
      }),
      updateMany: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id?: string; status?: unknown; runId?: string; stepIndex?: { gte: number } };
          data: Partial<FakeStep>;
        }) => {
          let count = 0;
          for (const step of steps) {
            if (where.id && step.id !== where.id) continue;
            if (where.runId && step.runId !== where.runId) continue;
            if (where.stepIndex?.gte !== undefined && step.stepIndex < where.stepIndex.gte) continue;
            if (typeof where.status === 'string' && step.status !== where.status) continue;
            const inList = (where.status as { in?: string[] } | undefined)?.in;
            if (inList && !inList.includes(step.status)) continue;
            Object.assign(step, data);
            count++;
          }
          return { count };
        },
      ),
    },
    workbook: {
      findFirst: jest.fn(async () => ({ organizationId: 'org_test1234' })),
    },
    user: { findFirst: jest.fn(async () => ({ id: 'usr_owner' })) },
    // The per-step claim runs in a $transaction; the fake just invokes the callback with `client`.
    // Assigned AFTER the literal so the callback param can reference `typeof client` without a
    // self-referential initializer (tsc rejects that as an implicit-any cycle — TS7022).
    $transaction: jest.fn(),
  };
  client.$transaction.mockImplementation((fn: (tx: typeof client) => Promise<unknown>) => fn(client));

  return { client };
}

function makeService(deps: {
  db: ReturnType<typeof makeFakeDb>;
  bullEnqueuer: Partial<BullEnqueuerService>;
  jobService: Partial<JobService>;
  context?: RoutineValidationContext;
}): RoutineExecutorService {
  const referenceValidator = {
    loadContext: jest.fn().mockResolvedValue(deps.context ?? singleFolderContext()),
    validateRoutine: jest.fn().mockResolvedValue([]),
  } as unknown as RoutineReferenceValidatorService;

  return new RoutineExecutorService(
    deps.db as unknown as DbService,
    deps.bullEnqueuer as BullEnqueuerService,
    deps.jobService as JobService,
    {} as ScratchGitService,
    {} as RoutineParserService,
    referenceValidator,
    { logEvent: jest.fn() } as unknown as AuditLogService,
    { recordRoutineRun: jest.fn() } as unknown as RunCountService,
  );
}

/** A finished job whose waitUntilFinished resolves immediately. */
function finishedJob() {
  return { id: 'job_x', waitUntilFinished: jest.fn().mockResolvedValue(undefined) };
}

/**
 * Builds the (partial) DbJob a `getJobByBullJobId` mock returns. The executor only reads
 * status/error/progress, but the real signature returns a full `DbJob | null` — so type the result
 * as `DbJob` to keep the mock assignable to `JobService` under `tsc`.
 */
const dbJobResult = (fields: { status: string; error: string | null; progress: unknown }): DbJob =>
  fields as unknown as DbJob;

describe('RoutineExecutorService.execute', () => {
  function baseRun(overrides: Partial<FakeRun> = {}): FakeRun {
    return {
      id: RUN_ID,
      workbookId: WORKBOOK_ID,
      status: 'pending',
      trigger: 'manual',
      triggeredByUserId: 'usr_test1234',
      currentStepIndex: 0,
      startedAt: null,
      finishedAt: null,
      error: null,
      resultSummary: null,
      resultWarning: null,
      routineFilePath: 'routines/daily.yaml',
      routineName: 'Daily',
      ...overrides,
    };
  }

  it('runs a multi-step routine to completion, advancing the cursor and capturing the publish pipelineId', async () => {
    const run = baseRun();
    const steps = [makeStep(0, RoutineAction.PULL), makeStep(1, RoutineAction.PUBLISH, { folder: '/blog/posts' })];
    const db = makeFakeDb(run, steps);

    const enqueuePull = jest.fn().mockResolvedValue({ id: 'pull-job' });
    const enqueuePublish = jest.fn().mockResolvedValue({ id: 'publish-job' });
    const bullEnqueuer = {
      enqueuePullLinkedFolderFilesJob: enqueuePull,
      enqueueSelfPlanningPublishJob: enqueuePublish,
      getJob: jest.fn().mockResolvedValue(finishedJob()),
      getQueueEvents: jest.fn().mockReturnValue({}),
    };
    const jobService = {
      getJobByBullJobId: jest.fn(async (bullJobId: string) =>
        bullJobId === 'publish-job'
          ? dbJobResult({
              status: 'completed',
              error: null,
              progress: {
                publicProgress: {
                  pipelineId: 'pln_1',
                  failedCount: 0,
                  createsExecuted: 0,
                  editsExecuted: 5,
                  deletesExecuted: 0,
                },
              },
            })
          : dbJobResult({ status: 'completed', error: null, progress: null }),
      ),
      cancelJob: jest.fn(),
    };

    const service = makeService({ db, bullEnqueuer, jobService });
    await service.execute(RUN_ID);

    expect(run.status).toBe('completed');
    expect(run.currentStepIndex).toBe(2);
    expect(steps[0].status).toBe('completed');
    expect(steps[1].status).toBe('completed');
    expect(steps[1].pipelineId).toBe('pln_1');
    // resultSummary reflects the LAST step that ran (publish overwrote the pull's summary).
    expect(run.resultSummary).toBe('Published 5 changes');
    // A clean run (no step completed with a warning) leaves resultWarning null.
    expect(run.resultWarning).toBeNull();
    // Every step job is tagged with trigger 'routine' + the RoutineRunId; routine pulls default to
    // incremental (this step has no fullPull flag).
    expect(enqueuePull).toHaveBeenCalledWith(
      WORKBOOK_ID,
      expect.anything(),
      ['dfd_1'],
      undefined,
      expect.objectContaining({ trigger: 'routine', routineRunId: RUN_ID }),
      'incremental',
    );
    // publish: runAfterPlan true (PUBLISH), folderPath leading-slash.
    expect(enqueuePublish).toHaveBeenCalledWith(
      WORKBOOK_ID,
      expect.anything(),
      'coa_1',
      true,
      '/blog/posts',
      expect.objectContaining({ trigger: 'routine', routineRunId: RUN_ID }),
    );
  });

  it('forces a full pull when the step options set fullPull', async () => {
    const run = baseRun();
    const steps = [makeStep(0, RoutineAction.PULL, { options: { fullPull: true } })];
    const db = makeFakeDb(run, steps);

    const enqueuePull = jest.fn().mockResolvedValue({ id: 'pull-job' });
    const bullEnqueuer = {
      enqueuePullLinkedFolderFilesJob: enqueuePull,
      getJob: jest.fn().mockResolvedValue(finishedJob()),
      getQueueEvents: jest.fn().mockReturnValue({}),
    };
    const jobService = {
      getJobByBullJobId: jest.fn().mockResolvedValue(dbJobResult({ status: 'completed', error: null, progress: null })),
      cancelJob: jest.fn(),
    };

    const service = makeService({ db, bullEnqueuer, jobService });
    await service.execute(RUN_ID);

    expect(enqueuePull).toHaveBeenCalledWith(
      WORKBOOK_ID,
      expect.anything(),
      ['dfd_1'],
      undefined,
      expect.anything(),
      'full',
    );
    expect(run.status).toBe('completed');
  });

  it('pulls the de-duplicated union of a folders list in a single job', async () => {
    const run = baseRun();
    // A folders list naming two folders plus a duplicate of the first — the executor must resolve the
    // union and de-duplicate so the same DataFolderId is not pulled twice.
    const steps = [makeStep(0, RoutineAction.PULL, { folders: ['/blog/posts', '/blog/authors', 'dfd_1'] })];
    const db = makeFakeDb(run, steps);

    const twoFolderContext: RoutineValidationContext = {
      foldersByPath: new Map([
        ['blog/posts', [{ id: 'dfd_1', path: 'blog/posts', connectorAccountId: 'coa_1' }]],
        ['blog/authors', [{ id: 'dfd_2', path: 'blog/authors', connectorAccountId: 'coa_1' }]],
      ]),
      foldersById: new Map([
        ['dfd_1', { id: 'dfd_1', path: 'blog/posts', connectorAccountId: 'coa_1' }],
        ['dfd_2', { id: 'dfd_2', path: 'blog/authors', connectorAccountId: 'coa_1' }],
      ]),
      connectionsByName: new Map([['airtable', { id: 'coa_1', displayName: 'Airtable' }]]),
      connectionsById: new Map([['coa_1', { id: 'coa_1', displayName: 'Airtable' }]]),
      syncsById: new Map(),
    };

    const enqueuePull = jest.fn().mockResolvedValue({ id: 'pull-job' });
    const bullEnqueuer = {
      enqueuePullLinkedFolderFilesJob: enqueuePull,
      getJob: jest.fn().mockResolvedValue(finishedJob()),
      getQueueEvents: jest.fn().mockReturnValue({}),
    };
    const jobService = {
      getJobByBullJobId: jest.fn().mockResolvedValue(dbJobResult({ status: 'completed', error: null, progress: null })),
      cancelJob: jest.fn(),
    };

    const service = makeService({ db, bullEnqueuer, jobService, context: twoFolderContext });
    await service.execute(RUN_ID);

    expect(run.status).toBe('completed');
    expect(enqueuePull).toHaveBeenCalledWith(
      WORKBOOK_ID,
      expect.anything(),
      ['dfd_1', 'dfd_2'],
      undefined,
      expect.anything(),
      'incremental',
    );
  });

  it('fails the run and skips the rest when a step fails', async () => {
    const run = baseRun();
    const steps = [
      makeStep(0, RoutineAction.PULL),
      makeStep(1, RoutineAction.SYNC),
      makeStep(2, RoutineAction.PUBLISH),
    ];
    const db = makeFakeDb(run, steps);

    const bullEnqueuer = {
      enqueuePullLinkedFolderFilesJob: jest.fn().mockResolvedValue({ id: 'pull-job' }),
      enqueueSyncDataFoldersJob: jest.fn().mockResolvedValue({ id: 'sync-job' }),
      enqueueSelfPlanningPublishJob: jest.fn().mockResolvedValue({ id: 'publish-job' }),
      getJob: jest.fn().mockResolvedValue(finishedJob()),
      getQueueEvents: jest.fn().mockReturnValue({}),
    };
    const jobService = {
      getJobByBullJobId: jest.fn(async (bullJobId: string) =>
        bullJobId === 'sync-job'
          ? dbJobResult({ status: 'failed', error: 'sync blew up', progress: null })
          : dbJobResult({ status: 'completed', error: null, progress: null }),
      ),
      cancelJob: jest.fn(),
    };

    const service = makeService({ db, bullEnqueuer, jobService });
    await service.execute(RUN_ID);

    expect(steps[0].status).toBe('completed');
    expect(steps[1].status).toBe('failed');
    expect(steps[1].error).toBe('sync blew up');
    expect(steps[2].status).toBe('skipped');
    expect(run.status).toBe('failed');
    // The deprecated `error` keeps the prefixed message; `resultSummary` holds the clean step error.
    expect(run.error).toBe('Step 1 (sync) failed: sync blew up');
    expect(run.resultSummary).toBe('sync blew up');
    expect(bullEnqueuer.enqueueSelfPlanningPublishJob).not.toHaveBeenCalled();
  });

  it('cancels the in-flight job and fails the run on a step timeout', async () => {
    const run = baseRun();
    const steps = [makeStep(0, RoutineAction.PULL)];
    const db = makeFakeDb(run, steps);

    const bullEnqueuer = {
      enqueuePullLinkedFolderFilesJob: jest.fn().mockResolvedValue({ id: 'pull-job' }),
      // waitUntilFinished rejects (its ttl) and the DbJob is still active ⇒ timeout.
      getJob: jest
        .fn()
        .mockResolvedValue({ id: 'pull-job', waitUntilFinished: jest.fn().mockRejectedValue(new Error('timed out')) }),
      getQueueEvents: jest.fn().mockReturnValue({}),
    };
    const jobService = {
      getJobByBullJobId: jest.fn().mockResolvedValue({ status: 'active', error: null, progress: null }),
      cancelJob: jest.fn().mockResolvedValue({ success: true, message: 'ok' }),
    };

    const service = makeService({ db, bullEnqueuer, jobService });
    await service.execute(RUN_ID);

    expect(jobService.cancelJob).toHaveBeenCalledWith('pull-job', expect.anything());
    expect(steps[0].status).toBe('failed');
    expect(steps[0].error).toMatch(/timed out/i);
    expect(run.status).toBe('failed');
    // A timeout flows through the same failure path, so resultSummary gets the clean timeout message.
    expect(run.resultSummary).toMatch(/timed out/i);
  });

  it('completes a publish step WITH a warning (not a failure) when records were rejected', async () => {
    const run = baseRun();
    const steps = [makeStep(0, RoutineAction.PUBLISH, { folder: '/blog/posts' }), makeStep(1, RoutineAction.PULL)];
    const db = makeFakeDb(run, steps);

    const bullEnqueuer = {
      enqueueSelfPlanningPublishJob: jest.fn().mockResolvedValue({ id: 'publish-job' }),
      enqueuePullLinkedFolderFilesJob: jest.fn().mockResolvedValue({ id: 'pull-job' }),
      getJob: jest.fn().mockResolvedValue(finishedJob()),
      getQueueEvents: jest.fn().mockReturnValue({}),
    };
    const jobService = {
      getJobByBullJobId: jest.fn(async (bullJobId: string) =>
        bullJobId === 'publish-job'
          ? dbJobResult({
              status: 'completed',
              error: null,
              progress: {
                publicProgress: {
                  pipelineId: 'pln_9',
                  failedCount: 3,
                  createsExecuted: 0,
                  editsExecuted: 7,
                  deletesExecuted: 0,
                },
              },
            })
          : dbJobResult({
              status: 'completed',
              error: null,
              progress: { publicProgress: { folderCount: 1, createdCount: 0, updatedCount: 0, deletedCount: 0 } },
            }),
      ),
      cancelJob: jest.fn(),
    };

    const service = makeService({ db, bullEnqueuer, jobService });
    await service.execute(RUN_ID);

    expect(steps[0].status).toBe('completed');
    expect(steps[0].pipelineId).toBe('pln_9');
    expect(steps[0].error).toMatch(/3 record\(s\) rejected/);
    // The run keeps going and completes; the pull step (last to run) sets the final resultSummary.
    expect(steps[1].status).toBe('completed');
    expect(run.status).toBe('completed');
    expect(run.resultSummary).toBe('Pulled 1 folder — no changes');
    // resultSummary (last step) hides the publish warning, so the run-level resultWarning carries it —
    // the signal a consumer uses to show "completed with warnings" instead of a clean green check.
    expect(run.resultWarning).toMatch(/3 record\(s\) rejected/);
  });

  it('records a publish resultSummary that notes records rejected by the connector', async () => {
    // A single publish step so the publish summary is the run's final resultSummary.
    const run = baseRun();
    const steps = [makeStep(0, RoutineAction.PUBLISH, { folder: '/blog/posts' })];
    const db = makeFakeDb(run, steps);

    const bullEnqueuer = {
      enqueueSelfPlanningPublishJob: jest.fn().mockResolvedValue({ id: 'publish-job' }),
      getJob: jest.fn().mockResolvedValue(finishedJob()),
      getQueueEvents: jest.fn().mockReturnValue({}),
    };
    const jobService = {
      getJobByBullJobId: jest.fn().mockResolvedValue(
        dbJobResult({
          status: 'completed',
          error: null,
          progress: {
            publicProgress: {
              pipelineId: 'pln_9',
              failedCount: 3,
              createsExecuted: 4,
              editsExecuted: 0,
              deletesExecuted: 0,
            },
          },
        }),
      ),
      cancelJob: jest.fn(),
    };

    const service = makeService({ db, bullEnqueuer, jobService });
    await service.execute(RUN_ID);

    expect(run.status).toBe('completed');
    expect(run.resultSummary).toBe('Publishing failed • 3 updates rejected • 4 successful');
  });

  it('records a publish resultSummary with no "successful" clause when every change was rejected', async () => {
    // A single publish step so the publish summary is the run's final resultSummary.
    const run = baseRun();
    const steps = [makeStep(0, RoutineAction.PUBLISH, { folder: '/blog/posts' })];
    const db = makeFakeDb(run, steps);

    const bullEnqueuer = {
      enqueueSelfPlanningPublishJob: jest.fn().mockResolvedValue({ id: 'publish-job' }),
      getJob: jest.fn().mockResolvedValue(finishedJob()),
      getQueueEvents: jest.fn().mockReturnValue({}),
    };
    const jobService = {
      getJobByBullJobId: jest.fn().mockResolvedValue(
        dbJobResult({
          status: 'completed',
          error: null,
          progress: {
            publicProgress: {
              pipelineId: 'pln_10',
              failedCount: 1,
              createsExecuted: 0,
              editsExecuted: 0,
              deletesExecuted: 0,
            },
          },
        }),
      ),
      cancelJob: jest.fn(),
    };

    const service = makeService({ db, bullEnqueuer, jobService });
    await service.execute(RUN_ID);

    expect(run.status).toBe('completed');
    expect(run.resultSummary).toBe('Publishing failed • 1 update rejected');
  });

  it('attributes publish rejections to the destination service when its name is known', async () => {
    const run = baseRun();
    const steps = [makeStep(0, RoutineAction.PUBLISH, { folder: '/blog/posts' })];
    const db = makeFakeDb(run, steps);

    const bullEnqueuer = {
      enqueueSelfPlanningPublishJob: jest.fn().mockResolvedValue({ id: 'publish-job' }),
      getJob: jest.fn().mockResolvedValue(finishedJob()),
      getQueueEvents: jest.fn().mockReturnValue({}),
    };
    const jobService = {
      getJobByBullJobId: jest.fn().mockResolvedValue(
        dbJobResult({
          status: 'completed',
          error: null,
          progress: {
            publicProgress: {
              pipelineId: 'pln_11',
              failedCount: 1,
              createsExecuted: 0,
              editsExecuted: 2,
              deletesExecuted: 0,
              destinationServiceName: 'PostgreSQL',
            },
          },
        }),
      ),
      cancelJob: jest.fn(),
    };

    const service = makeService({ db, bullEnqueuer, jobService });
    await service.execute(RUN_ID);

    expect(run.status).toBe('completed');
    expect(run.resultSummary).toBe('Publishing failed • 1 update rejected by PostgreSQL • 2 successful');
  });

  it('records a publish-plan resultSummary noting the planned change count', async () => {
    const run = baseRun();
    const steps = [makeStep(0, RoutineAction.PUBLISH_PLAN, { folder: '/blog/posts' })];
    const db = makeFakeDb(run, steps);

    const bullEnqueuer = {
      enqueueSelfPlanningPublishJob: jest.fn().mockResolvedValue({ id: 'plan-job' }),
      getJob: jest.fn().mockResolvedValue(finishedJob()),
      getQueueEvents: jest.fn().mockReturnValue({}),
    };
    const jobService = {
      getJobByBullJobId: jest.fn().mockResolvedValue(
        dbJobResult({
          status: 'completed',
          error: null,
          progress: {
            publicProgress: {
              pipelineId: 'pln_2',
              createsPlanned: 3,
              editsPlanned: 2,
              deletesPlanned: 0,
              failedCount: 0,
            },
          },
        }),
      ),
      cancelJob: jest.fn(),
    };

    const service = makeService({ db, bullEnqueuer, jobService });
    await service.execute(RUN_ID);

    expect(run.status).toBe('completed');
    expect(run.resultSummary).toBe('Staged a publish plan (5 changes)');
  });

  it('records a pull resultSummary with the changed-record count across folders', async () => {
    const run = baseRun();
    const steps = [makeStep(0, RoutineAction.PULL)];
    const db = makeFakeDb(run, steps);

    const bullEnqueuer = {
      enqueuePullLinkedFolderFilesJob: jest.fn().mockResolvedValue({ id: 'pull-job' }),
      getJob: jest.fn().mockResolvedValue(finishedJob()),
      getQueueEvents: jest.fn().mockReturnValue({}),
    };
    const jobService = {
      getJobByBullJobId: jest.fn().mockResolvedValue(
        dbJobResult({
          status: 'completed',
          error: null,
          progress: {
            publicProgress: { folderCount: 2, totalFiles: 10, createdCount: 2, updatedCount: 1, deletedCount: 0 },
          },
        }),
      ),
      cancelJob: jest.fn(),
    };

    const service = makeService({ db, bullEnqueuer, jobService });
    await service.execute(RUN_ID);

    expect(run.status).toBe('completed');
    expect(run.resultSummary).toBe('Pulled 3 records across 2 folders');
  });

  it('fails the run and skips publish when a sync job completes but a table failed', async () => {
    // The sync job ends DbJob=completed (it never throws); the table failure lives only in
    // publicProgress.tables[].status. The executor must read that and fail the step, not advance.
    const run = baseRun();
    const steps = [makeStep(0, RoutineAction.SYNC), makeStep(1, RoutineAction.PUBLISH, { folder: '/blog/posts' })];
    const db = makeFakeDb(run, steps);

    const bullEnqueuer = {
      enqueueSyncDataFoldersJob: jest.fn().mockResolvedValue({ id: 'sync-job' }),
      enqueueSelfPlanningPublishJob: jest.fn().mockResolvedValue({ id: 'publish-job' }),
      getJob: jest.fn().mockResolvedValue(finishedJob()),
      getQueueEvents: jest.fn().mockReturnValue({}),
    };
    const jobService = {
      getJobByBullJobId: jest.fn(async (bullJobId: string) =>
        bullJobId === 'sync-job'
          ? dbJobResult({
              status: 'completed',
              error: null,
              progress: {
                publicProgress: {
                  totalFilesSynced: 0,
                  tables: [
                    {
                      id: 'dfd_zTgOoJiknY',
                      name: 'Video Games',
                      status: 'failed',
                      errors: [{ sourceRemoteId: '', error: 'scratch-git 404: /api/repo/read/...' }],
                    },
                  ],
                },
              },
            })
          : dbJobResult({ status: 'completed', error: null, progress: null }),
      ),
      cancelJob: jest.fn(),
    };

    const service = makeService({ db, bullEnqueuer, jobService });
    await service.execute(RUN_ID);

    expect(steps[0].status).toBe('failed');
    expect(steps[0].error).toMatch(/Video Games/);
    expect(steps[0].error).toMatch(/scratch-git 404/);
    expect(steps[1].status).toBe('skipped');
    expect(run.status).toBe('failed');
    // resultSummary holds the clean failure (no "Step N (action) failed:" prefix — that's on `error`).
    expect(run.resultSummary).toMatch(/Video Games/);
    expect(run.resultSummary).toMatch(/scratch-git 404/);
    expect(run.resultSummary).not.toMatch(/^Step /);
    expect(run.error).toMatch(/^Step 0 \(sync\) failed:/);
    expect(bullEnqueuer.enqueueSelfPlanningPublishJob).not.toHaveBeenCalled();
  });

  it('records a sync resultSummary with the synced-record count across tables', async () => {
    const run = baseRun();
    const steps = [makeStep(0, RoutineAction.SYNC)];
    const db = makeFakeDb(run, steps);

    const bullEnqueuer = {
      enqueueSyncDataFoldersJob: jest.fn().mockResolvedValue({ id: 'sync-job' }),
      getJob: jest.fn().mockResolvedValue(finishedJob()),
      getQueueEvents: jest.fn().mockReturnValue({}),
    };
    const jobService = {
      getJobByBullJobId: jest.fn().mockResolvedValue(
        dbJobResult({
          status: 'completed',
          error: null,
          progress: {
            publicProgress: {
              totalFilesSynced: 2,
              tables: [{ id: 'dfd_1', name: 'Video Games', status: 'completed', errors: [] }],
            },
          },
        }),
      ),
      cancelJob: jest.fn(),
    };

    const service = makeService({ db, bullEnqueuer, jobService });
    await service.execute(RUN_ID);

    expect(run.status).toBe('completed');
    expect(run.resultSummary).toBe('Synced 2 records across 1 table');
  });

  it('completes a sync step and proceeds when every table succeeded', async () => {
    const run = baseRun();
    const steps = [makeStep(0, RoutineAction.SYNC), makeStep(1, RoutineAction.PUBLISH, { folder: '/blog/posts' })];
    const db = makeFakeDb(run, steps);

    const enqueuePublish = jest.fn().mockResolvedValue({ id: 'publish-job' });
    const bullEnqueuer = {
      enqueueSyncDataFoldersJob: jest.fn().mockResolvedValue({ id: 'sync-job' }),
      enqueueSelfPlanningPublishJob: enqueuePublish,
      getJob: jest.fn().mockResolvedValue(finishedJob()),
      getQueueEvents: jest.fn().mockReturnValue({}),
    };
    const jobService = {
      getJobByBullJobId: jest.fn(async (bullJobId: string) =>
        bullJobId === 'sync-job'
          ? dbJobResult({
              status: 'completed',
              error: null,
              progress: {
                publicProgress: {
                  totalFilesSynced: 2,
                  tables: [{ id: 'dfd_1', name: 'Video Games', status: 'completed', errors: [] }],
                },
              },
            })
          : dbJobResult({
              status: 'completed',
              error: null,
              progress: { publicProgress: { pipelineId: 'pln_1', failedCount: 0 } },
            }),
      ),
      cancelJob: jest.fn(),
    };

    const service = makeService({ db, bullEnqueuer, jobService });
    await service.execute(RUN_ID);

    expect(steps[0].status).toBe('completed');
    expect(steps[0].error).toBeNull();
    expect(steps[1].status).toBe('completed');
    expect(run.status).toBe('completed');
    expect(enqueuePublish).toHaveBeenCalled();
  });

  it('does nothing when the run cannot be claimed (already owned/terminal)', async () => {
    const run = baseRun({ status: 'completed' });
    const steps = [makeStep(0, RoutineAction.PULL)];
    const db = makeFakeDb(run, steps);

    const bullEnqueuer = {
      enqueuePullLinkedFolderFilesJob: jest.fn(),
      getJob: jest.fn(),
      getQueueEvents: jest.fn(),
    };
    const service = makeService({ db, bullEnqueuer, jobService: { getJobByBullJobId: jest.fn() } });

    await service.execute(RUN_ID);

    expect(bullEnqueuer.enqueuePullLinkedFolderFilesJob).not.toHaveBeenCalled();
    expect(run.status).toBe('completed');
  });

  it('re-attaches to an already-terminal current step on resume and advances (reaper path)', async () => {
    // Run is already running, cursor at step 1, step 0 done, step 1 has a finished job recorded.
    const run = baseRun({ status: 'running', currentStepIndex: 1, startedAt: new Date('2025-01-01') });
    const steps = [
      makeStep(0, RoutineAction.PULL, { status: 'completed', jobId: 'pull-job' }),
      makeStep(1, RoutineAction.SYNC, { status: 'running', jobId: 'sync-job' }),
    ];
    const db = makeFakeDb(run, steps);

    const bullEnqueuer = {
      enqueueSyncDataFoldersJob: jest.fn(),
      getJob: jest.fn().mockResolvedValue(finishedJob()),
      getQueueEvents: jest.fn().mockReturnValue({}),
    };
    const jobService = {
      getJobByBullJobId: jest.fn().mockResolvedValue({ status: 'completed', error: null, progress: null }),
      cancelJob: jest.fn(),
    };

    const service = makeService({ db, bullEnqueuer, jobService });
    await service.execute(RUN_ID);

    // It did NOT re-enqueue the already-running step...
    expect(bullEnqueuer.enqueueSyncDataFoldersJob).not.toHaveBeenCalled();
    // ...it mirrored the finished job and completed the run.
    expect(steps[1].status).toBe('completed');
    expect(run.status).toBe('completed');
  });
});

describe('RoutineExecutorService.triggerRun', () => {
  const PARSED_ROUTINE = {
    name: 'Daily',
    schedule: null,
    comment: null,
    steps: [
      {
        action: RoutineAction.PULL,
        name: null,
        folder: null,
        folders: null,
        connection: null,
        sync: null,
        comment: null,
        timeout: null,
        options: null,
      },
    ],
  };

  function makeTriggerService(routineRunCreate: jest.Mock) {
    const db = {
      client: {
        workbook: { findFirst: jest.fn().mockResolvedValue({ organizationId: 'org_test1234' }) },
        routineRun: { create: routineRunCreate },
      },
    } as unknown as DbService;
    const scratchGit = {
      getRepoFile: jest.fn().mockResolvedValue({ content: 'yaml' }),
    } as unknown as ScratchGitService;
    const parser = { parse: jest.fn().mockReturnValue({ routine: PARSED_ROUTINE }) } as unknown as RoutineParserService;
    const referenceValidator = {
      validateRoutine: jest.fn().mockResolvedValue([]),
    } as unknown as RoutineReferenceValidatorService;
    const auditLog = { logEvent: jest.fn().mockResolvedValue(undefined) } as unknown as AuditLogService;
    return new RoutineExecutorService(
      db,
      {} as BullEnqueuerService,
      {} as JobService,
      scratchGit,
      parser,
      referenceValidator,
      auditLog,
      { recordRoutineRun: jest.fn() } as unknown as RunCountService,
    );
  }

  it('creates a pending run + steps and kicks the executor', async () => {
    const created = {
      id: RUN_ID,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      workbookId: WORKBOOK_ID,
      routineFilePath: 'routines/daily.yaml',
      routineName: 'Daily',
      status: 'pending',
      trigger: 'manual',
      triggeredByUserId: 'usr_1',
      startedAt: null,
      finishedAt: null,
      error: null,
      currentStepIndex: 0,
    };
    const service = makeTriggerService(jest.fn().mockResolvedValue(created));
    // Don't actually run the loop — assert it was kicked.
    const executeSpy = jest.spyOn(service, 'execute').mockResolvedValue(undefined);

    const run = await service.triggerRun(WORKBOOK_ID, 'routines/daily.yaml', 'manual', {
      userId: 'usr_1',
      organizationId: 'org_test1234',
    });

    expect(run.id).toBe(RUN_ID);
    expect(executeSpy).toHaveBeenCalledWith(RUN_ID);
  });

  it('rejects with 409 when the routine already has an active run (unique-index P2002)', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' });
    const service = makeTriggerService(jest.fn().mockRejectedValue(p2002));
    const executeSpy = jest.spyOn(service, 'execute').mockResolvedValue(undefined);

    await expect(
      service.triggerRun(WORKBOOK_ID, 'routines/daily.yaml', 'manual', {
        userId: 'usr_1',
        organizationId: 'org_test1234',
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(executeSpy).not.toHaveBeenCalled();
  });
});
