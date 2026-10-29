import { NotFoundException } from '@nestjs/common';
import { WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { isBaseVersionStale, RoutineDefinitionStoreService } from '../routine-definition-store.service';

const WORKBOOK_ID = 'wkb_test1234' as WorkbookId;
const ORG_ID = 'org_test1234';
const REPO_ID = `${ORG_ID}/${WORKBOOK_ID}/${WORKBOOK_ID}`;

function row(filePath: string, content: string, version = 1) {
  return {
    id: `rdf_${filePath.replace(/[^a-z0-9]/gi, '').slice(0, 10)}`,
    createdAt: new Date('2026-06-19T00:00:00.000Z'),
    updatedAt: new Date('2026-06-19T00:00:00.000Z'),
    workbookId: WORKBOOK_ID,
    filePath,
    content,
    version,
    source: 'web',
    updatedByUserId: 'usr_test1234',
  };
}

describe('RoutineDefinitionStoreService', () => {
  let workbookFindFirst: jest.Mock;
  let workbookUpdateMany: jest.Mock;
  let definitionFindMany: jest.Mock;
  let definitionFindUnique: jest.Mock;
  let definitionCreate: jest.Mock;
  let definitionCreateMany: jest.Mock;
  let definitionUpdate: jest.Mock;
  let definitionDeleteMany: jest.Mock;
  let executeRaw: jest.Mock;
  let listRepoFiles: jest.Mock;
  let readRepoFiles: jest.Mock;
  let service: RoutineDefinitionStoreService;

  /** A workbook whose routines still live only in git. */
  function workbookPendingImport() {
    workbookFindFirst.mockResolvedValue({ organizationId: ORG_ID, routinesPendingGitImport: true });
  }
  /** A workbook already imported — git must never be touched. */
  function workbookImported() {
    workbookFindFirst.mockResolvedValue({ organizationId: ORG_ID, routinesPendingGitImport: false });
  }

  beforeEach(() => {
    workbookFindFirst = jest.fn();
    workbookImported();
    workbookUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    definitionFindMany = jest.fn().mockResolvedValue([]);
    definitionFindUnique = jest.fn().mockResolvedValue(null);
    definitionCreate = jest
      .fn()
      .mockImplementation(({ data }: { data: { filePath: string; content: string } }) =>
        Promise.resolve({ ...row(data.filePath, data.content), ...data }),
      );
    definitionCreateMany = jest
      .fn()
      .mockImplementation(({ data }: { data: unknown[] }) => Promise.resolve({ count: data.length }));
    definitionUpdate = jest
      .fn()
      .mockImplementation(({ where, data }: { where: { id: string }; data: { content: string } }) =>
        Promise.resolve({ ...row('routines/x.yaml', data.content, 2), id: where.id }),
      );
    definitionDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
    executeRaw = jest.fn().mockResolvedValue(undefined);
    listRepoFiles = jest.fn().mockResolvedValue([]);
    readRepoFiles = jest.fn().mockResolvedValue([]);

    const routineDefinitionDelegate = {
      findMany: definitionFindMany,
      findUnique: definitionFindUnique,
      create: definitionCreate,
      createMany: definitionCreateMany,
      update: definitionUpdate,
      deleteMany: definitionDeleteMany,
    };
    const client = {
      workbook: { findFirst: workbookFindFirst, updateMany: workbookUpdateMany },
      routineDefinition: routineDefinitionDelegate,
      // The transaction client exposes the same delegates plus $executeRaw (the advisory lock).
      $transaction: jest
        .fn()
        .mockImplementation((callback: (tx: unknown) => Promise<unknown>) =>
          callback({ routineDefinition: routineDefinitionDelegate, $executeRaw: executeRaw }),
        ),
    };
    const db = { client } as unknown as DbService;
    const scratchGitService = { listRepoFiles, readRepoFiles } as unknown as ScratchGitService;
    service = new RoutineDefinitionStoreService(db, scratchGitService);
  });

  describe('ensureImportedFromGit (the one-shot git fallback)', () => {
    it('does nothing — no git access — when the workbook was already imported', async () => {
      workbookImported();

      const outcome = await service.ensureImportedFromGit(WORKBOOK_ID);

      expect(outcome).toEqual({ attempted: false, imported: 0, skippedExisting: 0, skippedInvalid: 0 });
      expect(listRepoFiles).not.toHaveBeenCalled();
      expect(workbookUpdateMany).not.toHaveBeenCalled();
    });

    it('throws NotFound for an unknown workbook', async () => {
      workbookFindFirst.mockResolvedValue(null);

      await expect(service.ensureImportedFromGit(WORKBOOK_ID)).rejects.toThrow(NotFoundException);
    });

    it('imports every routines/*.yaml|yml as a git-import row and clears the flag', async () => {
      workbookPendingImport();
      listRepoFiles.mockResolvedValue([
        { name: 'a.yaml', path: 'routines/a.yaml', type: 'file' },
        { name: 'b.yml', path: 'routines/b.yml', type: 'file' },
        { name: 'README.md', path: 'routines/README.md', type: 'file' },
        { name: 'sub', path: 'routines/sub', type: 'directory' },
      ]);
      readRepoFiles.mockResolvedValue([
        { path: 'routines/a.yaml', content: 'name: A\n' },
        { path: 'routines/b.yml', content: 'name: B\n' },
      ]);

      const outcome = await service.ensureImportedFromGit(WORKBOOK_ID);

      expect(listRepoFiles).toHaveBeenCalledWith(REPO_ID, 'main', 'routines');
      expect(readRepoFiles).toHaveBeenCalledWith(REPO_ID, 'main', ['routines/a.yaml', 'routines/b.yml']);
      expect(definitionCreateMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            workbookId: WORKBOOK_ID,
            filePath: 'routines/a.yaml',
            content: 'name: A\n',
            source: 'git-import',
            updatedByUserId: null,
          }),
          expect.objectContaining({
            workbookId: WORKBOOK_ID,
            filePath: 'routines/b.yml',
            content: 'name: B\n',
            source: 'git-import',
          }),
        ],
        skipDuplicates: true,
      });
      expect(workbookUpdateMany).toHaveBeenCalledWith({
        where: { id: WORKBOOK_ID, routinesPendingGitImport: true },
        data: { routinesPendingGitImport: false },
      });
      expect(outcome).toEqual({ attempted: true, imported: 2, skippedExisting: 0, skippedInvalid: 0 });
    });

    it('clears the flag with no rows when git has no routines folder (scratch-git maps 404 to [])', async () => {
      workbookPendingImport();
      listRepoFiles.mockResolvedValue([]);

      const outcome = await service.ensureImportedFromGit(WORKBOOK_ID);

      expect(definitionCreateMany).not.toHaveBeenCalled();
      expect(readRepoFiles).not.toHaveBeenCalled();
      expect(workbookUpdateMany).toHaveBeenCalledTimes(1);
      expect(outcome).toEqual({ attempted: true, imported: 0, skippedExisting: 0, skippedInvalid: 0 });
    });

    it('lets an existing DB row win over the git copy (skipDuplicates) and reports it as skippedExisting', async () => {
      workbookPendingImport();
      listRepoFiles.mockResolvedValue([
        { name: 'a.yaml', path: 'routines/a.yaml', type: 'file' },
        { name: 'b.yaml', path: 'routines/b.yaml', type: 'file' },
      ]);
      readRepoFiles.mockResolvedValue([
        { path: 'routines/a.yaml', content: 'name: A (git)\n' },
        { path: 'routines/b.yaml', content: 'name: B\n' },
      ]);
      // Postgres skipped one of the two inserts because a row for that path already exists.
      definitionCreateMany.mockResolvedValue({ count: 1 });

      const outcome = await service.ensureImportedFromGit(WORKBOOK_ID);

      expect(definitionCreateMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
      expect(outcome).toEqual({ attempted: true, imported: 1, skippedExisting: 1, skippedInvalid: 0 });
    });

    it('skips a git file whose path fails the routine path rules and still clears the flag', async () => {
      workbookPendingImport();
      listRepoFiles.mockResolvedValue([
        { name: 'ok.yaml', path: 'routines/ok.yaml', type: 'file' },
        { name: 'bad.yaml', path: 'routines/nested/bad.yaml', type: 'file' },
      ]);
      readRepoFiles.mockResolvedValue([
        { path: 'routines/ok.yaml', content: 'name: Ok\n' },
        { path: 'routines/nested/bad.yaml', content: 'name: Bad\n' },
      ]);

      const outcome = await service.ensureImportedFromGit(WORKBOOK_ID);

      expect(definitionCreateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: [expect.objectContaining({ filePath: 'routines/ok.yaml' })] }),
      );
      expect(outcome).toEqual({ attempted: true, imported: 1, skippedExisting: 0, skippedInvalid: 1 });
      expect(workbookUpdateMany).toHaveBeenCalledTimes(1);
    });

    it('drops a file that was listed but unreadable (raced deletion) instead of importing an empty routine', async () => {
      workbookPendingImport();
      listRepoFiles.mockResolvedValue([
        { name: 'a.yaml', path: 'routines/a.yaml', type: 'file' },
        { name: 'gone.yaml', path: 'routines/gone.yaml', type: 'file' },
      ]);
      readRepoFiles.mockResolvedValue([
        { path: 'routines/a.yaml', content: 'name: A\n' },
        { path: 'routines/gone.yaml', content: null },
      ]);

      const outcome = await service.ensureImportedFromGit(WORKBOOK_ID);

      expect(definitionCreateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: [expect.objectContaining({ filePath: 'routines/a.yaml' })] }),
      );
      expect(outcome.imported).toBe(1);
    });

    it('throws and leaves the flag set when scratch-git fails, so nothing is ever imported partially', async () => {
      workbookPendingImport();
      listRepoFiles.mockRejectedValue(new Error('scratch-git 503'));

      await expect(service.ensureImportedFromGit(WORKBOOK_ID)).rejects.toThrow('scratch-git 503');

      expect(definitionCreateMany).not.toHaveBeenCalled();
      expect(workbookUpdateMany).not.toHaveBeenCalled();
    });

    it('throws and leaves the flag set when the batch read fails after listing', async () => {
      workbookPendingImport();
      listRepoFiles.mockResolvedValue([{ name: 'a.yaml', path: 'routines/a.yaml', type: 'file' }]);
      readRepoFiles.mockRejectedValue(new Error('scratch-git 500'));

      await expect(service.ensureImportedFromGit(WORKBOOK_ID)).rejects.toThrow('scratch-git 500');

      expect(definitionCreateMany).not.toHaveBeenCalled();
      expect(workbookUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('listDefinitions / getDefinition', () => {
    it('runs the import first, then reads rows ordered by path', async () => {
      workbookPendingImport();
      definitionFindMany.mockResolvedValue([row('routines/a.yaml', 'name: A\n')]);

      const definitions = await service.listDefinitions(WORKBOOK_ID);

      expect(listRepoFiles).toHaveBeenCalledTimes(1);
      expect(definitionFindMany).toHaveBeenCalledWith({
        where: { workbookId: WORKBOOK_ID },
        orderBy: { filePath: 'asc' },
      });
      expect(definitions).toHaveLength(1);
    });

    it('surfaces the store error (and reads no rows) when the import fails', async () => {
      workbookPendingImport();
      listRepoFiles.mockRejectedValue(new Error('scratch-git 503'));

      await expect(service.listDefinitions(WORKBOOK_ID)).rejects.toThrow('scratch-git 503');
      expect(definitionFindMany).not.toHaveBeenCalled();
    });

    it('returns null for a missing path WITHOUT falling back to git once the workbook is imported', async () => {
      workbookImported();
      definitionFindUnique.mockResolvedValue(null);

      const definition = await service.getDefinition(WORKBOOK_ID, 'routines/deleted.yaml');

      expect(definition).toBeNull();
      expect(listRepoFiles).not.toHaveBeenCalled();
    });
  });

  describe('upsertDefinition', () => {
    it('creates a new row at version 1', async () => {
      definitionFindUnique.mockResolvedValue(null);

      const { outcome } = await service.upsertDefinition(WORKBOOK_ID, 'routines/a.yaml', 'name: A\n', {
        source: 'web',
        updatedByUserId: 'usr_1',
      });

      expect(outcome).toBe('created');
      const [createArgs] = definitionCreate.mock.calls[0] as [{ data: Record<string, unknown> }];
      expect(createArgs.data).toMatchObject({
        workbookId: WORKBOOK_ID,
        filePath: 'routines/a.yaml',
        content: 'name: A\n',
        source: 'web',
        updatedByUserId: 'usr_1',
      });
      expect(definitionUpdate).not.toHaveBeenCalled();
    });

    it('bumps the version when the content changes', async () => {
      definitionFindUnique.mockResolvedValue(row('routines/a.yaml', 'name: Old\n', 3));

      const { outcome } = await service.upsertDefinition(WORKBOOK_ID, 'routines/a.yaml', 'name: New\n', {
        source: 'cli',
        updatedByUserId: 'usr_1',
      });

      expect(outcome).toBe('updated');
      expect(definitionUpdate).toHaveBeenCalledWith({
        where: { id: row('routines/a.yaml', '').id },
        data: { content: 'name: New\n', version: { increment: 1 }, source: 'cli', updatedByUserId: 'usr_1' },
      });
    });

    it('does not bump the version (no write at all) when the content is byte-identical', async () => {
      definitionFindUnique.mockResolvedValue(row('routines/a.yaml', 'name: Same\n', 3));

      const { outcome, definition } = await service.upsertDefinition(WORKBOOK_ID, 'routines/a.yaml', 'name: Same\n', {
        source: 'generated',
        updatedByUserId: null,
      });

      expect(outcome).toBe('unchanged');
      expect(definition.version).toBe(3);
      expect(definitionUpdate).not.toHaveBeenCalled();
      expect(definitionCreate).not.toHaveBeenCalled();
    });
  });

  describe('deleteDefinition', () => {
    it('returns true when a row was deleted and false when there was none', async () => {
      definitionDeleteMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

      await expect(service.deleteDefinition(WORKBOOK_ID, 'routines/a.yaml')).resolves.toBe(true);
      await expect(service.deleteDefinition(WORKBOOK_ID, 'routines/a.yaml')).resolves.toBe(false);
      expect(definitionDeleteMany).toHaveBeenCalledWith({
        where: { workbookId: WORKBOOK_ID, filePath: 'routines/a.yaml' },
      });
    });
  });

  describe('applyPush', () => {
    const push = (overrides: Partial<Parameters<RoutineDefinitionStoreService['applyPush']>[1]> = {}) => ({
      upserts: [],
      deletes: [],
      source: 'cli' as const,
      updatedByUserId: 'usr_1',
      ...overrides,
    });

    it('takes the per-workbook advisory lock, creates/updates/deletes, and returns every file version', async () => {
      definitionFindMany
        // rows before the push
        .mockResolvedValueOnce([
          row('routines/edit.yaml', 'name: Old\n', 2),
          row('routines/gone.yaml', 'name: Gone\n', 1),
        ])
        // rows after the push
        .mockResolvedValueOnce([
          { filePath: 'routines/edit.yaml', version: 3 },
          { filePath: 'routines/new.yaml', version: 1 },
        ]);

      const result = await service.applyPush(
        WORKBOOK_ID,
        push({
          upserts: [
            { filePath: 'routines/new.yaml', content: 'name: New\n', baseVersion: null },
            { filePath: 'routines/edit.yaml', content: 'name: Edited\n', baseVersion: 2 },
          ],
          deletes: [{ filePath: 'routines/gone.yaml', baseVersion: 1 }],
        }),
      );

      expect(executeRaw).toHaveBeenCalledTimes(1);
      const [createArgs] = definitionCreate.mock.calls[0] as [{ data: Record<string, unknown> }];
      expect(createArgs.data).toMatchObject({ filePath: 'routines/new.yaml', content: 'name: New\n', source: 'cli' });
      expect(definitionUpdate).toHaveBeenCalledWith({
        where: { id: row('routines/edit.yaml', '').id },
        data: { content: 'name: Edited\n', version: { increment: 1 }, source: 'cli', updatedByUserId: 'usr_1' },
      });
      expect(definitionDeleteMany).toHaveBeenCalledWith({
        where: { workbookId: WORKBOOK_ID, filePath: { in: ['routines/gone.yaml'] } },
      });
      expect(result).toEqual({
        status: 'applied',
        files: [
          { path: 'routines/edit.yaml', version: 3 },
          { path: 'routines/new.yaml', version: 1 },
        ],
        upsertedFilePaths: ['routines/new.yaml', 'routines/edit.yaml'],
        deletedFilePaths: ['routines/gone.yaml'],
      });
    });

    it('writes nothing and reports exactly the stale files when any baseVersion mismatches', async () => {
      definitionFindMany.mockResolvedValueOnce([
        row('routines/a.yaml', 'name: A\n', 3),
        row('routines/b.yaml', 'name: B\n', 1),
        row('routines/c.yaml', 'name: C\n', 1),
      ]);

      const result = await service.applyPush(
        WORKBOOK_ID,
        push({
          upserts: [
            { filePath: 'routines/a.yaml', content: 'name: A2\n', baseVersion: 1 }, // edited server-side (3)
            { filePath: 'routines/b.yaml', content: 'name: B2\n', baseVersion: 1 }, // fine
            { filePath: 'routines/c.yaml', content: 'name: C2\n', baseVersion: null }, // "new" but exists
            { filePath: 'routines/d.yaml', content: 'name: D\n', baseVersion: 4 }, // claimed v4, row gone
          ],
          deletes: [{ filePath: 'routines/b.yaml', baseVersion: 2 }], // stale delete
        }),
      );

      expect(result).toEqual({
        status: 'blocked_stale',
        staleFiles: [
          { path: 'routines/a.yaml', baseVersion: 1, currentVersion: 3 },
          { path: 'routines/c.yaml', baseVersion: null, currentVersion: 1 },
          { path: 'routines/d.yaml', baseVersion: 4, currentVersion: null },
          { path: 'routines/b.yaml', baseVersion: 2, currentVersion: 1 },
        ],
      });
      expect(definitionCreate).not.toHaveBeenCalled();
      expect(definitionUpdate).not.toHaveBeenCalled();
      expect(definitionDeleteMany).not.toHaveBeenCalled();
    });

    it('treats a missing baseVersion (pre-DEV-11399 CLI) as no guard, and deleting an absent path as a no-op', async () => {
      definitionFindMany
        .mockResolvedValueOnce([row('routines/a.yaml', 'name: A\n', 7)])
        .mockResolvedValueOnce([{ filePath: 'routines/a.yaml', version: 8 }]);

      const result = await service.applyPush(
        WORKBOOK_ID,
        push({
          upserts: [{ filePath: 'routines/a.yaml', content: 'name: A2\n', baseVersion: undefined }],
          deletes: [{ filePath: 'routines/never-existed.yaml', baseVersion: 1 }],
        }),
      );

      expect(result.status).toBe('applied');
      expect(definitionUpdate).toHaveBeenCalledTimes(1);
      expect(definitionDeleteMany).not.toHaveBeenCalled();
    });

    it('skips an upsert whose content is byte-identical (no version bump), so re-pushing converges', async () => {
      definitionFindMany
        .mockResolvedValueOnce([row('routines/a.yaml', 'name: Same\n', 2)])
        .mockResolvedValueOnce([{ filePath: 'routines/a.yaml', version: 2 }]);

      const result = await service.applyPush(
        WORKBOOK_ID,
        push({ upserts: [{ filePath: 'routines/a.yaml', content: 'name: Same\n', baseVersion: 2 }] }),
      );

      expect(definitionUpdate).not.toHaveBeenCalled();
      expect(result).toMatchObject({ status: 'applied', upsertedFilePaths: [] });
    });
  });

  describe('isBaseVersionStale', () => {
    it.each([
      ['no guard', undefined, 3, false],
      ['no guard, row absent', undefined, null, false],
      ['matching version', 2, 2, false],
      ['expected new and row absent', null, null, false],
      ['edited server-side', 1, 2, true],
      ['expected new but row exists', null, 1, true],
      ['claimed a version but row gone', 3, null, true],
    ])('%s → stale=%s', (_label, baseVersion, currentVersion, expected) => {
      expect(isBaseVersionStale(baseVersion, currentVersion)).toBe(expected);
    });
  });
});
