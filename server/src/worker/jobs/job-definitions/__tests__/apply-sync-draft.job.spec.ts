/* eslint-disable @typescript-eslint/unbound-method -- jest mock assertions on service methods */
import type { PrismaClient } from '@prisma/client';
import type { MaterializePlaceholderResult, SyncDraftId, WorkbookId } from '@spinner/shared-types';
import { JobType } from '@spinner/shared-types';
import type { MaterializeSyncDraftOptions, SyncDraftService } from 'src/sync-draft/sync-draft.service';
import type { WorkbookEventService } from 'src/workbook/workbook-event.service';
import { ApplySyncDraftJobDefinition, ApplySyncDraftJobHandler } from '../apply-sync-draft.job';

const WORKBOOK_ID = 'wkb_1' as WorkbookId;
const DRAFT_ID = 'syd_1' as SyncDraftId;
const DB_JOB_ID = 'job_db_1';
const BULL_JOB_ID = 'apply-sync-draft-syd_1-abc12';

/** A draft row whose single table mapping is an unresolved placeholder table. */
function makeDraftRowWithOneUnresolvedPlaceholder(): Record<string, unknown> {
  return {
    id: DRAFT_ID,
    workbookId: WORKBOOK_ID,
    tableMappings: [
      {
        ref: 'tm1',
        source: { dataFolderId: 'dfd_src' },
        destination: {
          kind: 'placeholderTable',
          ref: 'ph_contacts',
          connectorAccountId: 'coa_1',
          createSpec: { ref: 'spec_contacts', name: 'Contacts', fields: [] },
        },
        columnMappings: [],
      },
    ],
  };
}

describe('ApplySyncDraftJobHandler', () => {
  function setup() {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'usr_1',
          organizationId: 'org_1',
          organization: null,
          workspacePermissions: [],
        }),
      },
      syncDraft: { findUnique: jest.fn().mockResolvedValue(makeDraftRowWithOneUnresolvedPlaceholder()) },
      dbJob: { findUnique: jest.fn().mockResolvedValue({ bullJobId: BULL_JOB_ID }) },
    } as unknown as PrismaClient;

    const syncDraftService = {
      materialize: jest.fn().mockResolvedValue({
        draft: {},
        results: [{ ref: 'ph_contacts', kind: 'table', status: 'created', remoteTableId: ['tbl1'] }],
        status: 'ok',
      }),
      apply: jest.fn().mockResolvedValue({ id: 'syn_new' }),
      clearActiveSaveJobIdIfOwnedByJob: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<SyncDraftService>;

    const workbookEventService = {
      sendWorkbookEvent: jest.fn(),
    } as unknown as jest.Mocked<WorkbookEventService>;

    const checkpoint = jest.fn().mockResolvedValue(undefined);
    const handler = new ApplySyncDraftJobHandler(prisma, syncDraftService, workbookEventService);
    return { handler, prisma, syncDraftService, workbookEventService, checkpoint };
  }

  function run(handler: ApplySyncDraftJobHandler, checkpoint: jest.Mock) {
    const data: ApplySyncDraftJobDefinition['data'] = {
      type: JobType.ApplySyncDraft,
      workbookId: WORKBOOK_ID,
      draftId: DRAFT_ID,
      userId: 'usr_1',
      organizationId: 'org_1',
      createRoutine: true,
      trigger: 'web',
    };
    return handler.run({
      jobId: DB_JOB_ID,
      data,
      progress: {
        publicProgress: {
          phase: 'materializing_tables',
          totalPlaceholders: 0,
          resolvedPlaceholders: 0,
          failedRefs: [],
        },
        jobProgress: {},
        connectorProgress: {},
        timestamp: 0,
      },
      abortSignal: new AbortController().signal,
      checkpoint,
    });
  }

  it('runs materialize then apply, reports done with the syncId, clears activeSaveJobId, and sends completion events', async () => {
    const { handler, syncDraftService, workbookEventService, checkpoint } = setup();

    await run(handler, checkpoint);

    expect(syncDraftService.materialize).toHaveBeenCalledWith(
      DRAFT_ID,
      expect.objectContaining({ userId: 'usr_1' }),
      expect.objectContaining({ calledByActiveSaveJob: true }),
    );
    expect(syncDraftService.apply).toHaveBeenCalledWith(
      DRAFT_ID,
      expect.objectContaining({ userId: 'usr_1' }),
      expect.objectContaining({ createRoutine: true, calledByActiveSaveJob: true }),
    );
    expect(syncDraftService.clearActiveSaveJobIdIfOwnedByJob).toHaveBeenCalledWith(DRAFT_ID, BULL_JOB_ID);

    const checkpointCalls = checkpoint.mock.calls as Array<
      [{ publicProgress: ApplySyncDraftJobDefinition['publicProgress'] }]
    >;
    const finalCheckpoint = checkpointCalls[checkpointCalls.length - 1][0].publicProgress;
    expect(finalCheckpoint).toMatchObject({
      phase: 'done',
      totalPlaceholders: 1,
      resolvedPlaceholders: 1,
      failedRefs: [],
      syncId: 'syn_new',
    });

    const eventTypes = (workbookEventService.sendWorkbookEvent as jest.Mock).mock.calls.map(
      ([, event]: [unknown, { type: string }]) => event.type,
    );
    expect(eventTypes).toEqual(['job-started', 'job-completed']);
  });

  it('feeds the running placeholder count from materialize batch callbacks into checkpoints', async () => {
    const { handler, syncDraftService, checkpoint } = setup();
    (syncDraftService.materialize as jest.Mock).mockImplementation(
      async (_draftId: SyncDraftId, _actor: unknown, options: MaterializeSyncDraftOptions) => {
        const results: MaterializePlaceholderResult[] = [
          { ref: 'ph_contacts', kind: 'table', status: 'created', remoteTableId: ['tbl1'] },
        ];
        await options.onBatchProgress?.('tables', results);
        return { draft: {}, results, status: 'ok' };
      },
    );

    await run(handler, checkpoint);

    const checkpointCalls = checkpoint.mock.calls as Array<
      [{ publicProgress: ApplySyncDraftJobDefinition['publicProgress'] }]
    >;
    const batchCheckpoint = checkpointCalls
      .map(([progress]) => progress.publicProgress)
      .find((progress) => progress.phase === 'materializing_tables' && progress.resolvedPlaceholders === 1);
    expect(batchCheckpoint).toBeDefined();
  });

  it('ticks resolvedPlaceholders from the per-table in-batch callback (single-batch progress, DEV-10875)', async () => {
    const { handler, syncDraftService, checkpoint } = setup();
    (syncDraftService.materialize as jest.Mock).mockImplementation(
      async (_draftId: SyncDraftId, _actor: unknown, options: MaterializeSyncDraftOptions) => {
        // The table lands mid-batch — before any batch-level result is available.
        await options.onPlaceholderCreatedInBatch?.('ph_contacts');
        const results: MaterializePlaceholderResult[] = [
          { ref: 'ph_contacts', kind: 'table', status: 'created', remoteTableId: ['tbl1'] },
        ];
        return { draft: {}, results, status: 'ok' };
      },
    );

    await run(handler, checkpoint);

    const checkpointCalls = checkpoint.mock.calls as Array<
      [{ publicProgress: ApplySyncDraftJobDefinition['publicProgress'] }]
    >;
    const midBatchCheckpoint = checkpointCalls
      .map(([progress]) => progress.publicProgress)
      .find((progress) => progress.phase === 'materializing_tables' && progress.resolvedPlaceholders === 1);
    expect(midBatchCheckpoint).toBeDefined();
  });

  it('fails the job (without applying) when materialize leaves failed placeholders, reporting failedRefs', async () => {
    const { handler, syncDraftService, workbookEventService, checkpoint } = setup();
    (syncDraftService.materialize as jest.Mock).mockResolvedValue({
      draft: {},
      results: [{ ref: 'ph_contacts', kind: 'table', status: 'failed', error: 'name collision' }],
      status: 'failed',
    });

    await expect(run(handler, checkpoint)).rejects.toThrow(/name collision/);

    expect(syncDraftService.apply).not.toHaveBeenCalled();
    // The stale id must not outlive the failed job (a stale id would reopen a dead progress view).
    expect(syncDraftService.clearActiveSaveJobIdIfOwnedByJob).toHaveBeenCalledWith(DRAFT_ID, BULL_JOB_ID);

    const checkpointCalls = checkpoint.mock.calls as Array<
      [{ publicProgress: ApplySyncDraftJobDefinition['publicProgress'] }]
    >;
    const finalCheckpoint = checkpointCalls[checkpointCalls.length - 1][0].publicProgress;
    expect(finalCheckpoint.failedRefs).toEqual([{ ref: 'ph_contacts', error: 'name collision' }]);

    const eventTypes = (workbookEventService.sendWorkbookEvent as jest.Mock).mock.calls.map(
      ([, event]: [unknown, { type: string }]) => event.type,
    );
    expect(eventTypes).toEqual(['job-started', 'job-failed']);
  });

  it('clears activeSaveJobId and sends job-failed when apply throws', async () => {
    const { handler, syncDraftService, workbookEventService, checkpoint } = setup();
    (syncDraftService.apply as jest.Mock).mockRejectedValue(new Error('validation failed'));

    await expect(run(handler, checkpoint)).rejects.toThrow('validation failed');

    expect(syncDraftService.clearActiveSaveJobIdIfOwnedByJob).toHaveBeenCalledWith(DRAFT_ID, BULL_JOB_ID);
    const eventTypes = (workbookEventService.sendWorkbookEvent as jest.Mock).mock.calls.map(
      ([, event]: [unknown, { type: string }]) => event.type,
    );
    expect(eventTypes).toEqual(['job-started', 'job-failed']);
  });
});
