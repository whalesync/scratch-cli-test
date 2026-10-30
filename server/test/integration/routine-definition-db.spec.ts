/**
 * Real-Postgres integration tests for RoutineDefinitionStoreService (DEV-11399) — the things
 * mocks can't prove: that `(workbookId, filePath)` is unique, that Workbook→RoutineDefinition
 * `onDelete: Cascade` removes rows, and that the one-shot git import is idempotent when two reads
 * race.
 *
 * scratch-git is mocked (the import source is the only git surface here); everything else is real
 * Prisma. Requires the `routine_definitions_in_db` migration to have been applied.
 */

import { PrismaClient } from '@prisma/client';
import { createWorkbookId, type WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { RoutineDefinitionStoreService } from 'src/routine/routine-definition-store.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';

describe('RoutineDefinitionStoreService (real DB)', () => {
  let prisma: PrismaClient;
  let store: RoutineDefinitionStoreService;
  let listRepoFiles: jest.Mock;
  let readRepoFiles: jest.Mock;
  let repoExists: jest.Mock;

  let orgId: string;
  let workbookId: WorkbookId;

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  beforeEach(async () => {
    listRepoFiles = jest.fn().mockResolvedValue([]);
    readRepoFiles = jest.fn().mockResolvedValue([]);
    repoExists = jest.fn().mockResolvedValue({ exists: true, hasHead: true });
    store = new RoutineDefinitionStoreService(
      { client: prisma } as unknown as DbService,
      { listRepoFiles, readRepoFiles, repoExists } as unknown as ScratchGitService,
    );

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
    // New workbooks start with the flag false (the schema default); tests that exercise the import flip it.
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

  describe('ensureImportedFromGit', () => {
    beforeEach(async () => {
      await prisma.workbook.update({ where: { id: workbookId }, data: { routinesPendingGitImport: true } });
      listRepoFiles.mockResolvedValue([
        { name: 'a.yaml', path: 'routines/a.yaml', type: 'file' },
        { name: 'b.yaml', path: 'routines/b.yaml', type: 'file' },
      ]);
      readRepoFiles.mockResolvedValue([
        { path: 'routines/a.yaml', content: 'name: A (git)\n' },
        { path: 'routines/b.yaml', content: 'name: B (git)\n' },
      ]);
    });

    it('imports git files once, lets a pre-existing row win, and never reads git again', async () => {
      // A row a user wrote after the flag was set (before the first read) — must survive the import.
      await prisma.routineDefinition.create({
        data: {
          id: 'rdf_userwrote1',
          workbookId,
          filePath: 'routines/a.yaml',
          content: 'name: A (user)\n',
          source: 'web',
        },
      });

      const outcome = await store.ensureImportedFromGit(workbookId);
      const definitions = await store.listDefinitions(workbookId);

      expect(outcome).toEqual({
        attempted: true,
        configRepoMissing: false,
        imported: 1,
        skippedExisting: 1,
        skippedInvalid: 0,
      });
      expect(definitions.map((d) => [d.filePath, d.content, d.source])).toEqual([
        ['routines/a.yaml', 'name: A (user)\n', 'web'],
        ['routines/b.yaml', 'name: B (git)\n', 'git-import'],
      ]);
      // listDefinitions above ran after the flag was cleared: exactly one git listing in total.
      expect(listRepoFiles).toHaveBeenCalledTimes(1);
      const workbook = await prisma.workbook.findUniqueOrThrow({ where: { id: workbookId } });
      expect(workbook.routinesPendingGitImport).toBe(false);
    });

    it('converges when two reads race the import (no duplicate rows, flag cleared once)', async () => {
      const [outcomeA, outcomeB] = await Promise.all([
        store.ensureImportedFromGit(workbookId),
        store.ensureImportedFromGit(workbookId),
      ]);

      expect(outcomeA.imported + outcomeB.imported).toBe(2);
      expect(await prisma.routineDefinition.count({ where: { workbookId } })).toBe(2);
      const workbook = await prisma.workbook.findUniqueOrThrow({ where: { id: workbookId } });
      expect(workbook.routinesPendingGitImport).toBe(false);
    });

    it('keeps the flag set when the git host has no such repo, and imports on a later read once it does', async () => {
      listRepoFiles.mockResolvedValueOnce([]); // what scratch-git answers for a repo it does not have
      repoExists.mockResolvedValueOnce({ exists: false, hasHead: false });

      const firstOutcome = await store.ensureImportedFromGit(workbookId);
      expect(firstOutcome.configRepoMissing).toBe(true);
      expect((await prisma.workbook.findUniqueOrThrow({ where: { id: workbookId } })).routinesPendingGitImport).toBe(
        true,
      );
      expect(await prisma.routineDefinition.count({ where: { workbookId } })).toBe(0);

      // The right git host answers next time (mocks fall back to the beforeEach defaults).
      const secondOutcome = await store.ensureImportedFromGit(workbookId);
      expect(secondOutcome.imported).toBe(2);
      expect((await prisma.workbook.findUniqueOrThrow({ where: { id: workbookId } })).routinesPendingGitImport).toBe(
        false,
      );
    });

    it('a deleted routine does not resurrect from git after the import', async () => {
      await store.ensureImportedFromGit(workbookId);
      await store.deleteDefinition(workbookId, 'routines/a.yaml');

      expect(await store.getDefinition(workbookId, 'routines/a.yaml')).toBeNull();
      expect((await store.listDefinitions(workbookId)).map((d) => d.filePath)).toEqual(['routines/b.yaml']);
    });
  });
});
