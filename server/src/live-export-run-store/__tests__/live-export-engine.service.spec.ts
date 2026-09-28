/* eslint-disable @typescript-eslint/unbound-method */
import { LiveExportEngine, RoutineAction, WorkbookManager } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import type { ExperimentsService } from 'src/experiments/experiments.service';
import { LiveExportEngineService, type RoutineStepForEngineDecision } from '../live-export-engine.service';
import { LiveExportRunLifecycleService } from '../live-export-run-lifecycle.service';
import { RunStoreBudgetExceededError, type RunStoreClient } from '../run-store-client';

const LIVE_EXPORT_STEPS: RoutineStepForEngineDecision[] = [
  { action: RoutineAction.DISCARD_PENDING_CHANGES },
  { action: RoutineAction.PULL, options: { fullPull: true }, pullDataFolderIds: ['dfd_s', 'dfd_other'] },
  { action: RoutineAction.PULL, options: { fullPull: true }, pullDataFolderIds: ['dfd_d', 'dfd_ref'] },
  { action: RoutineAction.SYNC, syncId: 'syn_1' },
  { action: RoutineAction.PUBLISH },
];

function engineServiceOver(state: {
  managedBy?: string | null;
  settings?: Record<string, unknown> | null;
  columnMappings?: unknown[];
  killSwitchOn?: boolean;
}): LiveExportEngineService {
  const db = {
    client: {
      workbook: {
        findUnique: jest.fn().mockResolvedValue({
          managedBy: state.managedBy === undefined ? WorkbookManager.WS_EXPORT : state.managedBy,
          settings: state.settings === undefined ? { live_export_engine: 'run_store' } : state.settings,
        }),
      },
      sync: {
        findUnique: jest.fn().mockResolvedValue({
          mappings: { version: 1, tableMappings: [] },
          mappingsV2: {
            version: 2,
            tableMappings: [
              {
                sourceDataFolderId: 'dfd_s',
                destinationDataFolderId: 'dfd_d',
                columnMappings: state.columnMappings ?? [
                  { source: { kind: 'column', columnId: 'title' }, destinationColumnId: 'title' },
                ],
              },
            ],
          },
        }),
      },
    },
  } as unknown as DbService;
  const experimentsService = {
    getBooleanFlag: jest.fn().mockResolvedValue(state.killSwitchOn ?? false),
  } as unknown as ExperimentsService;
  return new LiveExportEngineService(db, experimentsService);
}

const decide = (service: LiveExportEngineService, steps = LIVE_EXPORT_STEPS) =>
  service.decideEngineForRoutineRun({ workbookId: 'wkb_1', routineRunId: 'rrn_1', steps });

describe('LiveExportEngineService', () => {
  it('uses the run-store engine for a Live Export that asks for it', async () => {
    expect(await decide(engineServiceOver({}))).toMatchObject({ engine: LiveExportEngine.RUN_STORE });
  });

  it('uses the run-store engine when every folder a foreign-key transformer references is pulled', async () => {
    const service = engineServiceOver({
      columnMappings: [
        {
          source: {
            kind: 'column',
            columnId: 'author',
            transformer: { type: 'source_fk_to_dest_fk', options: { referencedDataFolderId: 'dfd_ref' } },
          },
          destinationColumnId: 'author',
        },
      ],
    });
    expect(await decide(service)).toMatchObject({ engine: LiveExportEngine.RUN_STORE });
  });

  it.each([
    ['a workbook that is not a Live Export', { managedBy: null }, LIVE_EXPORT_STEPS],
    ['a Live Export whose settings do not ask for it', { settings: {} }, LIVE_EXPORT_STEPS],
    ['a Live Export whose settings are null', { settings: null }, LIVE_EXPORT_STEPS],
    ['an unrecognized engine value', { settings: { live_export_engine: 'turbo' } }, LIVE_EXPORT_STEPS],
    ['a Live Export that asks for it while the kill switch is on', { killSwitchOn: true }, LIVE_EXPORT_STEPS],
    [
      'a sync with asset transformers',
      {
        columnMappings: [
          {
            source: {
              kind: 'column',
              columnId: 'image',
              transformer: {
                type: 'source_asset_to_dest_asset',
                options: { sourceDataFolderId: 'dfd_s', destinationDataFolderId: 'dfd_d' },
              },
            },
            destinationColumnId: 'image',
          },
        ],
      },
      LIVE_EXPORT_STEPS,
    ],
    [
      'an incremental destination pull',
      {},
      LIVE_EXPORT_STEPS.map((step, index) => (index === 2 ? { ...step, options: { fullPull: false } } : step)),
    ],
    ['a routine with two syncs', {}, [...LIVE_EXPORT_STEPS, { action: RoutineAction.SYNC, syncId: 'syn_2' }]],
    ['a routine with no sync', {}, LIVE_EXPORT_STEPS.filter((step) => step.action !== String(RoutineAction.SYNC))],
    ['a routine with another kind of step', {}, [...LIVE_EXPORT_STEPS, { action: 'publish_plan' }]],
    ['a routine that does not start with a discard', {}, LIVE_EXPORT_STEPS.slice(1)],
    [
      'a sync whose destination folder no pull step pulls',
      {},
      LIVE_EXPORT_STEPS.map((step, index) => (index === 2 ? { ...step, pullDataFolderIds: ['dfd_ref'] } : step)),
    ],
    [
      'a sync with a foreign-key transformer into a folder no pull step pulls',
      {
        columnMappings: [
          {
            source: {
              kind: 'column',
              columnId: 'author',
              transformer: { type: 'source_fk_to_dest_fk', options: { referencedDataFolderId: 'dfd_unpulled' } },
            },
            destinationColumnId: 'author',
          },
        ],
      },
      LIVE_EXPORT_STEPS,
    ],
  ])('keeps %s on the classic engine', async (_label, state, steps) => {
    expect(await decide(engineServiceOver(state), steps)).toMatchObject({ engine: LiveExportEngine.CLASSIC });
  });
});

describe('LiveExportRunLifecycleService', () => {
  function lifecycleOver(
    persistedEngine: string | null,
    decision: 'run_store' | 'classic' | 'throws',
    createOrClearRunStore: () => Promise<void> = () => Promise.resolve(),
  ) {
    const run = { liveExportEngine: persistedEngine };
    const db = {
      client: {
        routineRun: {
          updateMany: jest.fn(
            ({ where, data }: { where: { liveExportEngine: null }; data: { liveExportEngine: string } }) => {
              if (where.liveExportEngine === null && run.liveExportEngine === null)
                run.liveExportEngine = data.liveExportEngine;
              return Promise.resolve({ count: 1 });
            },
          ),
          findUnique: jest.fn(() => Promise.resolve({ ...run })),
        },
      },
    } as unknown as DbService;
    const engineService = {
      decideEngineForRoutineRun: jest.fn(() =>
        decision === 'throws'
          ? Promise.reject(new Error('db down'))
          : Promise.resolve({ engine: decision, reason: 'test' }),
      ),
    } as unknown as LiveExportEngineService;
    const runStoreClient = {
      deleteRunStore: jest.fn().mockResolvedValue(undefined),
      createOrClearRunStore: jest.fn(createOrClearRunStore),
    } as unknown as RunStoreClient;
    return {
      lifecycle: new LiveExportRunLifecycleService(db, engineService, runStoreClient),
      run,
      engineService,
      runStoreClient,
    };
  }

  it('decides once, persists the decision, and hands every step the run store key', async () => {
    const { lifecycle, run } = lifecycleOver(null, 'run_store');

    const key = await lifecycle.resolveRunStoreKeyForRun(
      { id: 'rrn_abc', workbookId: 'wkb_1', liveExportEngine: null, currentStepIndex: 0 },
      [],
    );

    expect(key).toBe('le-rrn_abc');
    expect(run.liveExportEngine).toBe('run_store');
  });

  it('creates the run store up front, and runs classic when the git service has no room for it', async () => {
    const roomy = lifecycleOver(null, 'run_store');
    const full = lifecycleOver(null, 'run_store', () =>
      Promise.reject(new RunStoreBudgetExceededError('le-rrn_abc', 'run store budget exceeded')),
    );
    const run = { id: 'rrn_abc', workbookId: 'wkb_1', liveExportEngine: null, currentStepIndex: 0 };

    expect(await roomy.lifecycle.resolveRunStoreKeyForRun(run, [])).toBe('le-rrn_abc');
    expect(roomy.runStoreClient.createOrClearRunStore).toHaveBeenCalledWith('le-rrn_abc');
    expect(await full.lifecycle.resolveRunStoreKeyForRun(run, [])).toBeUndefined();
    expect(full.run.liveExportEngine).toBe('classic');
  });

  it('keeps the engine a resumed run started with, without deciding again', async () => {
    const { lifecycle, engineService } = lifecycleOver('classic', 'run_store');

    const key = await lifecycle.resolveRunStoreKeyForRun(
      { id: 'rrn_abc', workbookId: 'wkb_1', liveExportEngine: 'classic', currentStepIndex: 0 },
      [],
    );

    expect(key).toBeUndefined();
    expect(engineService.decideEngineForRoutineRun).not.toHaveBeenCalled();
  });

  it('falls back to classic when the decision itself fails', async () => {
    const { lifecycle, run } = lifecycleOver(null, 'throws');

    const key = await lifecycle.resolveRunStoreKeyForRun(
      { id: 'rrn_abc', workbookId: 'wkb_1', liveExportEngine: null, currentStepIndex: 0 },
      [],
    );

    expect(key).toBeUndefined();
    expect(run.liveExportEngine).toBe('classic');
  });

  it('keeps a run that is already past its first step without an engine on classic', async () => {
    const { lifecycle, run, engineService } = lifecycleOver(null, 'run_store');

    const key = await lifecycle.resolveRunStoreKeyForRun(
      { id: 'rrn_abc', workbookId: 'wkb_1', liveExportEngine: null, currentStepIndex: 2 },
      [],
    );

    expect(key).toBeUndefined();
    expect(run.liveExportEngine).toBe('classic');
    expect(engineService.decideEngineForRoutineRun).not.toHaveBeenCalled();
  });

  it('never throws, even when persisting the decision fails', async () => {
    const { lifecycle } = lifecycleOver(null, 'run_store');
    Object.assign(lifecycle, {
      db: { client: { routineRun: { updateMany: jest.fn().mockRejectedValue(new Error('db down')) } } },
    });

    await expect(
      lifecycle.resolveRunStoreKeyForRun(
        { id: 'rrn_abc', workbookId: 'wkb_1', liveExportEngine: null, currentStepIndex: 0 },
        [],
      ),
    ).resolves.toBeUndefined();
  });

  it('deletes the run store of a finished run-store run only', async () => {
    const runStoreRun = lifecycleOver('run_store', 'run_store');
    const classicRun = lifecycleOver('classic', 'classic');

    runStoreRun.lifecycle.releaseRunStoreOfFinishedRun('rrn_abc');
    classicRun.lifecycle.releaseRunStoreOfFinishedRun('rrn_def');
    await new Promise((resolve) => setImmediate(resolve));

    expect(runStoreRun.runStoreClient.deleteRunStore).toHaveBeenCalledWith('le-rrn_abc');
    expect(classicRun.runStoreClient.deleteRunStore).not.toHaveBeenCalled();
  });
});
