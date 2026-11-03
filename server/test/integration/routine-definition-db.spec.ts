/**
 * Real-Postgres integration tests for RoutineDefinitionStoreService (DEV-11399) — the things
 * mocks can't prove: that `(workbookId, filePath)` is unique, that `version` only moves on a real
 * content change, and that Workbook→RoutineDefinition `onDelete: Cascade` removes rows.
 * Requires the `routine_definitions_in_db` migration to have been applied.
 */

import { PrismaClient } from '@prisma/client';
import { createWorkbookId, type WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { RoutineDefinitionStoreService } from 'src/routine/routine-definition-store.service';

describe('RoutineDefinitionStoreService (real DB)', () => {
  let prisma: PrismaClient;
  let store: RoutineDefinitionStoreService;

  let orgId: string;
  let workbookId: WorkbookId;

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  beforeEach(async () => {
    store = new RoutineDefinitionStoreService({ client: prisma } as unknown as DbService);

    const org = await prisma.organization.create({
      data: { id: 'org_routinedef_' + Date.now(), name: 'Test Org', clerkId: 'clerk_routinedef_' + Date.now() },
    });
    orgId = org.id;
    const user = await prisma.user.create({
      data: {
        id: 'user_routinedef_' + Date.now(),
        email: `routinedef-${Date.now()}@example.com`,
        organizationId: org.id,
      },
    });
    workbookId = createWorkbookId();
    await prisma.workbook.create({
      data: { id: workbookId, name: 'Routine Definitions', userId: user.id, organizationId: org.id },
    });
  });

  afterEach(async () => {
    await prisma.workbook.deleteMany({ where: { organizationId: orgId } });
    await prisma.user.deleteMany({ where: { organizationId: orgId } });
    await prisma.organization.delete({ where: { id: orgId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('rejects a second row for the same (workbookId, filePath)', async () => {
    await store.upsertDefinition(workbookId, 'routines/a.yaml', 'name: A\n', { source: 'web', updatedByUserId: null });

    await expect(
      prisma.routineDefinition.create({
        data: { id: 'rdf_duplicate1', workbookId, filePath: 'routines/a.yaml', content: 'name: Dup\n', source: 'web' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('bumps version on a content change and leaves it alone on an identical write', async () => {
    const created = await store.upsertDefinition(workbookId, 'routines/a.yaml', 'name: A\n', {
      source: 'web',
      updatedByUserId: null,
    });
    const unchanged = await store.upsertDefinition(workbookId, 'routines/a.yaml', 'name: A\n', {
      source: 'web',
      updatedByUserId: null,
    });
    const updated = await store.upsertDefinition(workbookId, 'routines/a.yaml', 'name: A2\n', {
      source: 'cli',
      updatedByUserId: 'usr_1',
    });

    expect(created).toMatchObject({ outcome: 'created', definition: { version: 1 } });
    expect(unchanged).toMatchObject({ outcome: 'unchanged', definition: { version: 1 } });
    expect(updated).toMatchObject({ outcome: 'updated', definition: { version: 2, source: 'cli' } });
  });

  it('cascades RoutineDefinition rows when the workbook is deleted', async () => {
    await store.upsertDefinition(workbookId, 'routines/a.yaml', 'name: A\n', { source: 'web', updatedByUserId: null });

    await prisma.workbook.delete({ where: { id: workbookId } });

    expect(await prisma.routineDefinition.count({ where: { workbookId } })).toBe(0);
  });

  it('deletes a row, after which the path reads as missing', async () => {
    await store.upsertDefinition(workbookId, 'routines/a.yaml', 'name: A\n', { source: 'web', updatedByUserId: null });
    await store.upsertDefinition(workbookId, 'routines/b.yaml', 'name: B\n', { source: 'web', updatedByUserId: null });

    await expect(store.deleteDefinition(workbookId, 'routines/a.yaml')).resolves.toBe(true);
    await expect(store.deleteDefinition(workbookId, 'routines/a.yaml')).resolves.toBe(false);

    expect(await store.getDefinition(workbookId, 'routines/a.yaml')).toBeNull();
    expect((await store.listDefinitions(workbookId)).map((d) => d.filePath)).toEqual(['routines/b.yaml']);
  });
});
