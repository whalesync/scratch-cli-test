import type { WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { FileReferenceService } from 'src/publish-plan/file-reference.service';
import { RefCleanerService } from 'src/publish-plan/ref-cleaner.service';
import type { SchemaHelperService } from 'src/publish-plan/schema-helper.service';
import type { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { InMemoryRunStoreClient } from '../in-memory-run-store-client';
import { readAllRunStoreEntries, runStoreKeyForRoutineRun } from '../run-store-client';
import {
  runStorePlanCollection,
  runStoreRecordsCollection,
  runStoreSyncOutputCollection,
} from '../run-store-collections';
import { RunStorePublishPlanBuilder } from '../run-store-publish-plan-builder';
import { RunStoreTableSpecStore } from '../run-store-table-spec-store';

const RUN_STORE_KEY = runStoreKeyForRoutineRun('rrn_plan');
const CONNECTOR_ACCOUNT_ID = 'coa_dest';
const TAGS_REMOTE_TABLE_ID = 'tbl_tags';

const TAGS_SPEC = {
  name: 'Tags',
  idPath: 'id',
  schema: { type: 'object', properties: { name: { type: 'string' } } },
} as unknown as BaseJsonTableSpec;
const POSTS_SPEC = {
  name: 'Posts',
  idPath: 'id',
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        'x-scratch-foreign-key': { linkedTableId: TAGS_REMOTE_TABLE_ID },
      },
    },
  },
} as unknown as BaseJsonTableSpec;

const record = (key: string, body: Record<string, unknown>) => ({
  key,
  meta: { recordId: String(body.id) },
  body: JSON.stringify(body),
});
const output = (key: string, body: Record<string, unknown> | null) => ({
  key,
  meta: { deleted: body === null },
  body: body === null ? null : JSON.stringify(body),
});

/**
 * Destination as pulled: tags t1, t2; posts p1 → t1, p2 → t2, p3 → t1 (untouched by the sync).
 * Sync output: t1 deleted; p1 rewritten byte-identical (the FK phase rewrites DATA-phase no-ops); p2 retitled;
 * a new post created.
 */
async function storeAfterSync(): Promise<InMemoryRunStoreClient> {
  const client = new InMemoryRunStoreClient();
  await client.createOrClearRunStore(RUN_STORE_KEY);
  const tableSpecStore = new RunStoreTableSpecStore(client, RUN_STORE_KEY);
  await tableSpecStore.writeTableSpec(
    { dataFolderId: 'dfd_tags', connectorAccountId: CONNECTOR_ACCOUNT_ID, folderPath: '/Tags' },
    TAGS_SPEC,
  );
  await tableSpecStore.writeTableSpec(
    { dataFolderId: 'dfd_posts', connectorAccountId: CONNECTOR_ACCOUNT_ID, folderPath: '/Posts' },
    POSTS_SPEC,
  );
  await client.putEntries(RUN_STORE_KEY, runStoreRecordsCollection('dfd_tags'), [
    record('Tags/t1.json', { id: 't1', name: 'One' }),
    record('Tags/t2.json', { id: 't2', name: 'Two' }),
  ]);
  await client.putEntries(RUN_STORE_KEY, runStoreRecordsCollection('dfd_posts'), [
    record('Posts/p1.json', { id: 'p1', title: 'A', tags: ['t1'] }),
    record('Posts/p2.json', { id: 'p2', title: 'B', tags: ['t2'] }),
    record('Posts/p3.json', { id: 'p3', title: 'C', tags: ['t1'] }),
  ]);
  await client.putEntries(RUN_STORE_KEY, runStoreSyncOutputCollection('dfd_tags'), [output('Tags/t1.json', null)]);
  await client.putEntries(RUN_STORE_KEY, runStoreSyncOutputCollection('dfd_posts'), [
    output('Posts/p1.json', { id: 'p1', title: 'A', tags: ['t1'] }),
    output('Posts/p2.json', { id: 'p2', title: 'B2', tags: ['t2'] }),
    output('Posts/new.json', { title: 'New', tags: ['t2'] }),
  ]);
  return client;
}

function builderOver(client: InMemoryRunStoreClient): RunStorePublishPlanBuilder {
  const db = {
    client: {
      dataFolder: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'dfd_tags', path: '/Tags', tableId: [TAGS_REMOTE_TABLE_ID], options: null },
          { id: 'dfd_posts', path: '/Posts', tableId: ['tbl_posts'], options: null },
        ]),
      },
    },
  } as unknown as DbService;
  const refCleanerService = new RefCleanerService();
  return new RunStorePublishPlanBuilder({
    runStoreClient: client,
    runStoreKey: RUN_STORE_KEY,
    db,
    refCleanerService,
    fileReferenceService: new FileReferenceService(db, refCleanerService, {} as SchemaHelperService),
  });
}

async function readPlan(client: InMemoryRunStoreClient) {
  const operations: Array<{ phase: unknown; filePath: unknown; content: unknown }> = [];
  for await (const entries of readAllRunStoreEntries(
    client,
    RUN_STORE_KEY,
    runStorePlanCollection(CONNECTOR_ACCOUNT_ID),
    {
      includeBodies: true,
    },
  )) {
    for (const entry of entries) {
      const body = JSON.parse(entry.body ?? '{}') as { content: unknown };
      operations.push({ phase: entry.meta.phase, filePath: entry.meta.filePath, content: body.content });
    }
  }
  return operations;
}

describe('RunStorePublishPlanBuilder', () => {
  it('plans deletes, edits, creates, and clears references to deleted records — including in byte-identical output', async () => {
    const client = await storeAfterSync();

    const counts = await builderOver(client).buildPlanUnlessAlreadyBuilt({
      workbookId: 'wkb_1' as WorkbookId,
      connectorAccountId: CONNECTOR_ACCOUNT_ID,
    });

    const plan = await readPlan(client);
    expect(plan.map(({ phase, filePath }) => `${String(phase)} ${String(filePath)}`).sort()).toEqual(
      [
        'delete Tags/t1.json',
        'edit Posts/p1.json',
        'edit Posts/p2.json',
        'create Posts/new.json',
        'edit Posts/p3.json',
      ].sort(),
    );
    // The reference to the deleted tag is cleared in the rewritten-but-identical p1 and the untouched p3.
    for (const filePath of ['Posts/p1.json', 'Posts/p3.json']) {
      expect(plan.find((operation) => operation.filePath === filePath)?.content).toMatchObject({ tags: [] });
    }
    expect(counts).toMatchObject({ deletesPlanned: 1, editsPlanned: 3, createsPlanned: 1 });
  });

  it('plans nothing for byte-identical output that references no deleted record', async () => {
    const client = await storeAfterSync();
    await client.deleteCollection(RUN_STORE_KEY, runStoreSyncOutputCollection('dfd_tags'));

    await builderOver(client).buildPlanUnlessAlreadyBuilt({
      workbookId: 'wkb_1' as WorkbookId,
      connectorAccountId: CONNECTOR_ACCOUNT_ID,
    });

    expect((await readPlan(client)).map((operation) => operation.filePath).sort()).toEqual(
      ['Posts/new.json', 'Posts/p2.json'].sort(),
    );
  });

  it.each([
    [{ folderPath: '/Tags' }, ['Tags/t1.json']],
    [{ filePath: 'Posts/p2.json' }, ['Posts/p2.json']],
  ])('narrows the plan to the publish scope %j', async (scope, expectedPaths) => {
    const client = await storeAfterSync();

    await builderOver(client).buildPlanUnlessAlreadyBuilt({
      workbookId: 'wkb_1' as WorkbookId,
      connectorAccountId: CONNECTOR_ACCOUNT_ID,
      scope,
    });

    expect((await readPlan(client)).map((operation) => operation.filePath)).toEqual(expectedPaths);
  });
});
