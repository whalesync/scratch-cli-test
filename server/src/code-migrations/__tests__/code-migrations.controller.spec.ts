/* eslint-disable @typescript-eslint/unbound-method */
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { DbService } from 'src/db/db.service';
import { WorkbookRepoService } from 'src/workbook/workbook-repo.service';
import { CodeMigrationsController } from '../code-migrations.controller';

const makeReqWithUser = (isAdmin = true) =>
  ({
    user: {
      id: 'usr_test',
      organizationId: 'org_test',
      role: isAdmin ? UserRole.ADMIN : UserRole.USER,
      authType: 'jwt',
      authSource: 'user',
    },
  }) as never;

function makeWorkbook(id: string, orgId = 'org_test') {
  return { id, organizationId: orgId };
}

describe('CodeMigrationsController', () => {
  let controller: CodeMigrationsController;
  let dbService: jest.Mocked<DbService>;
  let workbookRepoService: jest.Mocked<WorkbookRepoService>;

  beforeEach(() => {
    dbService = {
      client: {
        workbook: {
          findMany: jest.fn().mockResolvedValue([]),
          count: jest.fn().mockResolvedValue(0),
        },
      },
    } as unknown as jest.Mocked<DbService>;

    workbookRepoService = {
      initWorkbookRepo: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<WorkbookRepoService>;

    controller = new CodeMigrationsController(dbService, workbookRepoService);
  });

  describe('getAvailableMigrations', () => {
    it('returns init-workbook-repos', () => {
      const result = controller.getAvailableMigrations(makeReqWithUser());
      expect(result.migrations).toContain('init-workbook-repos');
    });

    it('rejects non-admin users', () => {
      expect(() => controller.getAvailableMigrations(makeReqWithUser(false))).toThrow(UnauthorizedException);
    });
  });

  describe('runMigration - init-workbook-repos', () => {
    it('initializes repos for workbooks by qty', async () => {
      const workbooks = [makeWorkbook('wkb_1', 'org_a'), makeWorkbook('wkb_2', 'org_b')];
      dbService.client.workbook.findMany = jest.fn().mockResolvedValue(workbooks);
      dbService.client.workbook.count = jest.fn().mockResolvedValue(2);

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'init-workbook-repos',
        qty: 10,
      });

      expect(workbookRepoService.initWorkbookRepo).toHaveBeenCalledTimes(2);
      expect(workbookRepoService.initWorkbookRepo).toHaveBeenCalledWith('org_a', 'wkb_1');
      expect(workbookRepoService.initWorkbookRepo).toHaveBeenCalledWith('org_b', 'wkb_2');
      expect(result.migratedIds).toEqual(['wkb_1', 'wkb_2']);
      expect(result.migrationName).toBe('init-workbook-repos');
    });

    it('initializes repos for specific workbook ids', async () => {
      const workbooks = [makeWorkbook('wkb_specific')];
      dbService.client.workbook.findMany = jest.fn().mockResolvedValue(workbooks);
      dbService.client.workbook.count = jest.fn().mockResolvedValue(5);

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'init-workbook-repos',
        ids: ['wkb_specific'],
      });

      expect(dbService.client.workbook.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: { in: ['wkb_specific'] } } }),
      );
      expect(result.migratedIds).toEqual(['wkb_specific']);
      expect(result.remainingCount).toBe(4);
    });

    it('continues on individual failures', async () => {
      const workbooks = [makeWorkbook('wkb_ok'), makeWorkbook('wkb_fail'), makeWorkbook('wkb_ok2')];
      dbService.client.workbook.findMany = jest.fn().mockResolvedValue(workbooks);
      dbService.client.workbook.count = jest.fn().mockResolvedValue(3);

      workbookRepoService.initWorkbookRepo = jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('git down'))
        .mockResolvedValueOnce(undefined);

      const result = await controller.runMigration(makeReqWithUser(), {
        migration: 'init-workbook-repos',
        qty: 10,
      });

      expect(workbookRepoService.initWorkbookRepo).toHaveBeenCalledTimes(3);
      expect(result.migratedIds).toEqual(['wkb_ok', 'wkb_ok2']);
    });

    it('rejects non-admin users', async () => {
      await expect(
        controller.runMigration(makeReqWithUser(false), {
          migration: 'init-workbook-repos',
          qty: 1,
        }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects unknown migration', async () => {
      await expect(
        controller.runMigration(makeReqWithUser(), {
          migration: 'does-not-exist',
          qty: 1,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
