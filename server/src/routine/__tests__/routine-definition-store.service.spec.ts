import { WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { RoutineDefinitionStoreService } from '../routine-definition-store.service';

const WORKBOOK_ID = 'wkb_test1234' as WorkbookId;

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
  let definitionFindMany: jest.Mock;
  let definitionFindUnique: jest.Mock;
  let definitionCreate: jest.Mock;
  let definitionUpdate: jest.Mock;
  let definitionDeleteMany: jest.Mock;
  let service: RoutineDefinitionStoreService;

  beforeEach(() => {
    definitionFindMany = jest.fn().mockResolvedValue([]);
    definitionFindUnique = jest.fn().mockResolvedValue(null);
    definitionCreate = jest
      .fn()
      .mockImplementation(({ data }: { data: { filePath: string; content: string } }) =>
        Promise.resolve({ ...row(data.filePath, data.content), ...data }),
      );
    definitionUpdate = jest
      .fn()
      .mockImplementation(({ where, data }: { where: { id: string }; data: { content: string } }) =>
        Promise.resolve({ ...row('routines/x.yaml', data.content, 2), id: where.id }),
      );
    definitionDeleteMany = jest.fn().mockResolvedValue({ count: 1 });

    const routineDefinitionDelegate = {
      findMany: definitionFindMany,
      findUnique: definitionFindUnique,
      create: definitionCreate,
      update: definitionUpdate,
      deleteMany: definitionDeleteMany,
    };
    const db = { client: { routineDefinition: routineDefinitionDelegate } } as unknown as DbService;
    service = new RoutineDefinitionStoreService(db);
  });

  describe('listDefinitions / getDefinition', () => {
    it('reads the workbook rows ordered by path', async () => {
      definitionFindMany.mockResolvedValue([row('routines/a.yaml', 'name: A\n')]);

      const definitions = await service.listDefinitions(WORKBOOK_ID);

      expect(definitionFindMany).toHaveBeenCalledWith({
        where: { workbookId: WORKBOOK_ID },
        orderBy: { filePath: 'asc' },
      });
      expect(definitions).toHaveLength(1);
    });

    it('returns null for a missing path', async () => {
      definitionFindUnique.mockResolvedValue(null);

      const definition = await service.getDefinition(WORKBOOK_ID, 'routines/deleted.yaml');

      expect(definition).toBeNull();
      expect(definitionFindUnique).toHaveBeenCalledWith({
        where: { workbookId_filePath: { workbookId: WORKBOOK_ID, filePath: 'routines/deleted.yaml' } },
      });
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
});
