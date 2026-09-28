import { DbService } from 'src/db/db.service';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { InMemoryRunStoreClient } from '../in-memory-run-store-client';
import { runStoreKeyForRoutineRun } from '../run-store-client';
import {
  parseRunStorePublishPipelineId,
  RUN_STORE_PLAN_STATE_COLLECTION,
  runStorePlanCollection,
  runStorePlanStateKey,
  runStorePublishPipelineId,
  runStoreRecordsCollection,
} from '../run-store-collections';
import { RunStorePublishPlanRunStorage } from '../run-store-publish-plan-run-storage';

const RUN_STORE_KEY = runStoreKeyForRoutineRun('rrn_publish');
const CONNECTOR_ACCOUNT_ID = 'coa_dest';
const PIPELINE_ID = runStorePublishPipelineId(RUN_STORE_KEY, CONNECTOR_ACCOUNT_ID);

async function storeWithPlan(): Promise<InMemoryRunStoreClient> {
  const client = new InMemoryRunStoreClient();
  await client.createOrClearRunStore(RUN_STORE_KEY);
  await client.putEntries(RUN_STORE_KEY, RUN_STORE_PLAN_STATE_COLLECTION, [
    { key: runStorePlanStateKey(CONNECTOR_ACCOUNT_ID), meta: { status: 'planned', createdAt: '2026-09-26T00:00:00Z' } },
  ]);
  const operation = (phase: string, filePath: string, extra: Record<string, unknown> = {}) => ({
    phase,
    dataFolderId: 'dfd_posts',
    filePath,
    status: 'pending',
    error: null,
    errorCode: null,
    remoteRecordId: null,
    isRecreate: false,
    ...extra,
  });
  await client.putEntries(RUN_STORE_KEY, runStorePlanCollection(CONNECTOR_ACCOUNT_ID), [
    {
      key: '0000000001',
      meta: operation('edit', 'Posts/1.json', { remoteRecordId: '1' }),
      body: JSON.stringify({ content: { id: '1', title: 'v2' }, changedFields: { title: 'v2' } }),
    },
    {
      key: '0000000002',
      meta: operation('create', 'Posts/new.json'),
      body: JSON.stringify({ content: { title: 'n' } }),
    },
    {
      key: '0000000003',
      meta: operation('backfill', 'Posts/new.json'),
      body: JSON.stringify({
        content: { tags: ['@/Webflow/Tags/t.json'] },
        changedFields: { tags: ['@/Webflow/Tags/t.json'] },
      }),
    },
  ]);
  await client.putEntries(RUN_STORE_KEY, runStoreRecordsCollection('dfd_posts'), [
    { key: 'Posts/1.json', meta: { recordId: '1' }, body: '{"id":"1"}' },
  ]);
  return client;
}

function storageOver(client: InMemoryRunStoreClient): RunStorePublishPlanRunStorage {
  const db = {
    client: {
      dataFolder: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'dfd_posts', path: '/Posts' },
          { id: 'dfd_tags', path: '/Tags' },
        ]),
      },
      connectorAccount: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ id: CONNECTOR_ACCOUNT_ID, displayName: 'Webflow', service: 'WEBFLOW' }]),
      },
    },
  } as unknown as DbService;
  return new RunStorePublishPlanRunStorage({
    runStoreClient: client,
    runStoreKey: RUN_STORE_KEY,
    db,
    fileIndexService: {} as FileIndexService,
    workbookId: 'wkb_1',
    userId: 'usr_1',
    connectorAccountId: CONNECTOR_ACCOUNT_ID,
  });
}

describe('run-store publish pipeline ids', () => {
  it('round-trips and rejects classic plan ids', () => {
    expect(PIPELINE_ID).toBe('le-rrn_publish.coa_dest');
    expect(parseRunStorePublishPipelineId(PIPELINE_ID)).toEqual({
      runStoreKey: RUN_STORE_KEY,
      connectorAccountId: CONNECTOR_ACCOUNT_ID,
    });
    expect(parseRunStorePublishPipelineId('9ff55517-6aa0-460b-a904-3839641e8354')).toBeNull();
  });
});

describe('RunStorePlanStore', () => {
  it('answers the run pipeline queries from the plan in the run store', async () => {
    const planStore = storageOver(await storeWithPlan()).openPlanStore(PIPELINE_ID);

    expect(await planStore.readPlan()).toMatchObject({
      id: PIPELINE_ID,
      status: 'planned',
      connectorAccountId: CONNECTOR_ACCOUNT_ID,
    });
    expect(await planStore.countOperationsInPhase('create')).toBe(1);
    expect(await planStore.listDataFolderIdsWithPendingOperationsInPhase('edit')).toEqual(['dfd_posts']);
    expect(await planStore.listPendingOperationIdsInPhaseForDataFolder('backfill', 'dfd_posts')).toEqual([
      '0000000003',
    ]);
    expect(await planStore.readOperationsByIdsOrderedById(['0000000003', '0000000001'])).toEqual([
      {
        id: '0000000001',
        filePath: 'Posts/1.json',
        content: { id: '1', title: 'v2' },
        changedFields: { title: 'v2' },
        remoteRecordId: '1',
        dataFolderId: 'dfd_posts',
        isRecreate: false,
      },
      {
        id: '0000000003',
        filePath: 'Posts/new.json',
        content: { tags: ['@/Webflow/Tags/t.json'] },
        changedFields: { tags: ['@/Webflow/Tags/t.json'] },
        remoteRecordId: null,
        dataFolderId: 'dfd_posts',
        isRecreate: false,
      },
    ]);
  });

  it('persists statuses so a resumed publish (a new store over the same run store) continues', async () => {
    const client = await storeWithPlan();
    const firstDelivery = storageOver(client).openPlanStore(PIPELINE_ID);
    await firstDelivery.markOperationsSucceeded(['0000000001']);
    await firstDelivery.markOperationFailed('0000000002', { error: 'rejected', errorCode: null });
    await firstDelivery.updatePlanStatus('creates-completed');

    const secondDelivery = storageOver(client).openPlanStore(PIPELINE_ID);

    expect(await secondDelivery.readPlan()).toMatchObject({ status: 'creates-completed' });
    expect(await secondDelivery.countOperationsInPhaseWithStatus('edit', 'success')).toBe(1);
    expect(await secondDelivery.listFailedOperationsOrderedByFilePath()).toEqual([
      { filePath: 'Posts/new.json', phase: 'create', error: 'rejected', errorCode: null },
    ]);
    expect(await secondDelivery.listPendingOperationIdsInPhaseForDataFolder('edit', 'dfd_posts')).toEqual([]);
  });
});

describe('RunStoreRecordWriteback + RunStorePseudoRefResolver', () => {
  it('records created ids for backfills and @/ refs, and looks up pulled ids for the rest', async () => {
    const client = await storeWithPlan();
    const storage = storageOver(client);
    const planStore = storage.openPlanStore(PIPELINE_ID);
    const plan = await planStore.readPlan();
    if (!plan) throw new Error('plan missing');
    const writeback = await storage.openRecordWriteback(plan, planStore);

    await writeback.writeBackCreatedRecords({
      phase: 'create',
      records: [
        { operationId: '0000000002', filePath: 'Posts/new.json', content: {}, createdRemoteRecordId: 'created-1' },
        { operationId: 'x', filePath: 'Tags/t.json', content: {}, createdRemoteRecordId: 'created-tag' },
        { operationId: 'y', filePath: 'Tags/no-id.json', content: {}, createdRemoteRecordId: null },
      ],
      dispatchedOperationCount: 3,
      connectorAccountId: CONNECTOR_ACCOUNT_ID,
    });

    // A new storage (a resumed job) sees the ids the first delivery recorded.
    const resumedWriteback = await storageOver(client).openRecordWriteback(plan, planStore);
    expect(
      await resumedWriteback.lookupRemoteRecordIdForFile({ filePath: 'Posts/new.json', connectorAccountId: null }),
    ).toBe('created-1');
    expect(
      await resumedWriteback.lookupRemoteRecordIdForFile({ filePath: 'Posts/1.json', connectorAccountId: null }),
    ).toBe('1');
    expect(
      await resumedWriteback.lookupRemoteRecordIdForFile({ filePath: 'Tags/no-id.json', connectorAccountId: null }),
    ).toBeNull();

    const resolver = storageOver(client).pseudoRefResolver;
    const contents = [{ tags: ['@/Webflow/Tags/t.json', '7'] }, { parent: '@/Webflow/Posts/1.json' }];
    expect(
      await resolver.findUnresolvablePseudoRefs('wkb_1', [...contents, { tag: '@/Webflow/Tags/missing.json' }]),
    ).toEqual(new Set(['@/Webflow/Tags/missing.json']));
    expect(await resolver.resolveBatchPseudoRefs('wkb_1', contents)).toEqual([
      { tags: ['created-tag', '7'] },
      { parent: '1' },
    ]);
  });
});
