/* eslint-disable @typescript-eslint/unbound-method */
import { BadGatewayException, BadRequestException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { WhalesyncImportPreviewBody, WorkbookId } from '@spinner/shared-types';
import { Service } from '@spinner/shared-types';
import axios, { AxiosError } from 'axios';
import type { ScratchConfigService } from 'src/config/scratch-config.service';
import type { Actor } from 'src/users/types';
import type { DataFolderService } from 'src/workbook/data-folder.service';
import { WhalesyncImportApiService } from '../whalesync-import-api.service';
import {
  makeAirtableSchema,
  makeDataFolder,
  makeWebflowSchema,
  makeWhalesyncColumn,
  makeWhalesyncColumnPair,
  makeWhalesyncExport,
  makeWhalesyncSource,
  makeWhalesyncTable,
  makeWhalesyncTablePair,
  resetIdCounter,
} from './fixtures';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const ACTOR: Actor = { userId: 'user_1', organizationId: 'org_1' };
const WORKBOOK_ID = 'wkb_test00001' as WorkbookId;
const VALID_BODY: WhalesyncImportPreviewBody = {
  whalesyncApiToken: 'ws-token-abc',
  coreBaseId: 'cb_123',
};

function buildService(overrides?: { dataFolders?: ReturnType<typeof makeDataFolder>[] }) {
  const dataFolderService = {
    listAll: jest.fn().mockResolvedValue(overrides?.dataFolders ?? []),
  } as unknown as DataFolderService;

  const configService = {
    getWhalesyncApiUrl: jest.fn().mockReturnValue('https://api.whalesync.com'),
  } as unknown as ScratchConfigService;

  const service = new WhalesyncImportApiService(dataFolderService, configService);
  return { service, dataFolderService, configService };
}

function makeMinimalValidExport() {
  return makeWhalesyncExport({
    sources: {
      left: makeWhalesyncSource({
        connectorType: 'airtable',
        remoteBaseId: 'appAAA',
        tables: [makeWhalesyncTable({ remoteId: 'tblPROD', connectorType: 'airtable' })],
      }),
      right: null,
    },
    tablePairs: [],
  });
}

function makeAxiosError(status: number): AxiosError {
  const error = new AxiosError('Request failed');
  error.response = { status, data: null, headers: {}, statusText: '', config: {} as never };
  return error;
}

beforeEach(() => {
  resetIdCounter();
  jest.clearAllMocks();
});

describe('WhalesyncImportApiService', () => {
  // ---------------------------------------------------------------------------
  // Happy path
  // ---------------------------------------------------------------------------
  describe('previewImport — happy path', () => {
    it('should return syncs, caveats, and unmatchedFolders for a valid export with no table pairs', async () => {
      const wsExport = makeMinimalValidExport();
      mockedAxios.get.mockResolvedValue({ data: wsExport });

      const dataFolders = [makeDataFolder({ connectorService: Service.AIRTABLE, tableId: ['appAAA', 'tblPROD'] })];
      const { service } = buildService({ dataFolders });

      const result = await service.previewImport(WORKBOOK_ID, VALID_BODY, ACTOR);

      expect(result).toHaveProperty('syncs');
      expect(result).toHaveProperty('caveats');
      expect(result).toHaveProperty('unmatchedFolders');
      expect(Array.isArray(result.syncs)).toBe(true);
      expect(Array.isArray(result.caveats)).toBe(true);
      expect(Array.isArray(result.unmatchedFolders)).toBe(true);
    });

    it('should produce syncs when export has matching table pairs and DataFolders', async () => {
      const leftCol = makeWhalesyncColumn({ name: 'Title' });
      const rightCol = makeWhalesyncColumn({ name: 'name', connectorType: 'webflow' });
      const leftTable = makeWhalesyncTable({ remoteId: 'tblPROD', connectorType: 'airtable', columns: [leftCol] });
      const rightTable = makeWhalesyncTable({ remoteId: 'col111', connectorType: 'webflow', columns: [rightCol] });

      const wsExport = makeWhalesyncExport({
        sources: {
          left: makeWhalesyncSource({ connectorType: 'airtable', remoteBaseId: 'appAAA', tables: [leftTable] }),
          right: makeWhalesyncSource({ connectorType: 'webflow', remoteBaseId: 'site111', tables: [rightTable] }),
        },
        tablePairs: [
          makeWhalesyncTablePair({
            leftTableId: leftTable.id,
            rightTableId: rightTable.id,
            syncDirection: 'left',
            columnPairs: [
              makeWhalesyncColumnPair({ leftColumnId: leftCol.id, rightColumnId: rightCol.id, syncDirection: 'left' }),
            ],
          }),
        ],
      });
      mockedAxios.get.mockResolvedValue({ data: wsExport });

      const dataFolders = [
        makeDataFolder({
          connectorService: Service.AIRTABLE,
          tableId: ['appAAA', 'tblPROD'],
          schema: makeAirtableSchema(['Title']),
        }),
        makeDataFolder({
          connectorService: Service.WEBFLOW,
          tableId: ['site111', 'col111'],
          schema: makeWebflowSchema(['name']),
        }),
      ];
      const { service } = buildService({ dataFolders });

      const result = await service.previewImport(WORKBOOK_ID, VALID_BODY, ACTOR);

      expect(result.syncs).toHaveLength(1);
      expect(result.syncs[0].mappings.tableMappings).toHaveLength(1);
      expect(result.syncs[0].mappings.tableMappings[0].columnMappings).toHaveLength(1);
    });

    it('should report unmatched folders when DataFolders are missing', async () => {
      const leftTable = makeWhalesyncTable({ remoteId: 'tblPROD', connectorType: 'airtable' });
      const wsExport = makeWhalesyncExport({
        sources: {
          left: makeWhalesyncSource({ connectorType: 'airtable', remoteBaseId: 'appAAA', tables: [leftTable] }),
          right: null,
        },
        tablePairs: [],
      });
      mockedAxios.get.mockResolvedValue({ data: wsExport });

      // No DataFolders provided — the airtable table should be unmatched
      const { service } = buildService({ dataFolders: [] });

      const result = await service.previewImport(WORKBOOK_ID, VALID_BODY, ACTOR);

      expect(result.unmatchedFolders).toHaveLength(1);
      expect(result.unmatchedFolders[0].whalesyncTableName).toBe('Products');
      expect(result.unmatchedFolders[0].side).toBe('left');
    });

    it('should call bottlenose with the correct URL and auth header', async () => {
      const wsExport = makeMinimalValidExport();
      mockedAxios.get.mockResolvedValue({ data: wsExport });

      const { service } = buildService();
      await service.previewImport(WORKBOOK_ID, VALID_BODY, ACTOR);

      expect(mockedAxios.get).toHaveBeenCalledWith('https://api.whalesync.com/rest/core-bases/cb_123/export', {
        headers: { Authorization: 'WS-API-Token ws-token-abc' },
      });
    });

    it('should URL-encode the coreBaseId', async () => {
      const wsExport = makeMinimalValidExport();
      mockedAxios.get.mockResolvedValue({ data: wsExport });

      const { service } = buildService();
      await service.previewImport(WORKBOOK_ID, { whalesyncApiToken: 'token', coreBaseId: 'id/with spaces' }, ACTOR);

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://api.whalesync.com/rest/core-bases/id%2Fwith%20spaces/export',
        expect.anything(),
      );
    });

    it('should pass workbookId and actor to dataFolderService.listAll', async () => {
      const wsExport = makeMinimalValidExport();
      mockedAxios.get.mockResolvedValue({ data: wsExport });

      const { service, dataFolderService } = buildService();
      await service.previewImport(WORKBOOK_ID, VALID_BODY, ACTOR);

      expect((dataFolderService as { listAll: jest.Mock }).listAll).toHaveBeenCalledWith(WORKBOOK_ID, ACTOR);
    });

    it('should use configService.getWhalesyncApiUrl for the base URL', async () => {
      const wsExport = makeMinimalValidExport();
      mockedAxios.get.mockResolvedValue({ data: wsExport });

      const { service, configService } = buildService();
      (configService as { getWhalesyncApiUrl: jest.Mock }).getWhalesyncApiUrl.mockReturnValue(
        'https://custom.example.com',
      );
      await service.previewImport(WORKBOOK_ID, VALID_BODY, ACTOR);

      expect(mockedAxios.get).toHaveBeenCalledWith(
        'https://custom.example.com/rest/core-bases/cb_123/export',
        expect.anything(),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------------
  describe('validation', () => {
    it('should throw BadRequestException for empty whalesyncApiToken', async () => {
      const { service } = buildService();

      await expect(
        service.previewImport(WORKBOOK_ID, { whalesyncApiToken: '', coreBaseId: 'cb_123' }, ACTOR),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException for empty coreBaseId', async () => {
      const { service } = buildService();

      await expect(
        service.previewImport(WORKBOOK_ID, { whalesyncApiToken: 'token', coreBaseId: '' }, ACTOR),
      ).rejects.toThrow(BadRequestException);
    });

    it('should not call bottlenose when validation fails', async () => {
      const { service } = buildService();

      await expect(
        service.previewImport(WORKBOOK_ID, { whalesyncApiToken: '', coreBaseId: '' }, ACTOR),
      ).rejects.toThrow(BadRequestException);

      expect(mockedAxios.get).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Bottlenose error mapping
  // ---------------------------------------------------------------------------
  describe('bottlenose error mapping', () => {
    it('should throw UnauthorizedException on 401', async () => {
      mockedAxios.get.mockRejectedValue(makeAxiosError(401));
      mockedAxios.isAxiosError.mockReturnValue(true);
      const { service } = buildService();

      await expect(service.previewImport(WORKBOOK_ID, VALID_BODY, ACTOR)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw UnauthorizedException on 403', async () => {
      mockedAxios.get.mockRejectedValue(makeAxiosError(403));
      mockedAxios.isAxiosError.mockReturnValue(true);
      const { service } = buildService();

      await expect(service.previewImport(WORKBOOK_ID, VALID_BODY, ACTOR)).rejects.toThrow(UnauthorizedException);
    });

    it('should throw NotFoundException on 404', async () => {
      mockedAxios.get.mockRejectedValue(makeAxiosError(404));
      mockedAxios.isAxiosError.mockReturnValue(true);
      const { service } = buildService();

      await expect(service.previewImport(WORKBOOK_ID, VALID_BODY, ACTOR)).rejects.toThrow(NotFoundException);
    });

    it('should throw BadGatewayException on other HTTP status (e.g. 500)', async () => {
      mockedAxios.get.mockRejectedValue(makeAxiosError(500));
      mockedAxios.isAxiosError.mockReturnValue(true);
      const { service } = buildService();

      await expect(service.previewImport(WORKBOOK_ID, VALID_BODY, ACTOR)).rejects.toThrow(BadGatewayException);
    });

    it('should throw BadGatewayException on non-axios error (network failure)', async () => {
      mockedAxios.get.mockRejectedValue(new Error('ECONNREFUSED'));
      mockedAxios.isAxiosError.mockReturnValue(false);
      const { service } = buildService();

      await expect(service.previewImport(WORKBOOK_ID, VALID_BODY, ACTOR)).rejects.toThrow(BadGatewayException);
    });

    it('should throw BadGatewayException on non-Error thrown value', async () => {
      mockedAxios.get.mockRejectedValue('string error');
      mockedAxios.isAxiosError.mockReturnValue(false);
      const { service } = buildService();

      await expect(service.previewImport(WORKBOOK_ID, VALID_BODY, ACTOR)).rejects.toThrow(BadGatewayException);
    });
  });

  // ---------------------------------------------------------------------------
  // Response validation
  // ---------------------------------------------------------------------------
  describe('response validation', () => {
    it('should throw BadGatewayException when response is null', async () => {
      mockedAxios.get.mockResolvedValue({ data: null });
      const { service } = buildService();

      await expect(service.previewImport(WORKBOOK_ID, VALID_BODY, ACTOR)).rejects.toThrow(BadGatewayException);
    });

    it('should throw BadGatewayException when response is not an object', async () => {
      mockedAxios.get.mockResolvedValue({ data: 'not-json' });
      const { service } = buildService();

      await expect(service.previewImport(WORKBOOK_ID, VALID_BODY, ACTOR)).rejects.toThrow(BadGatewayException);
    });

    it('should throw BadGatewayException when response has wrong shape', async () => {
      mockedAxios.get.mockResolvedValue({ data: { foo: 'bar' } });
      const { service } = buildService();

      await expect(service.previewImport(WORKBOOK_ID, VALID_BODY, ACTOR)).rejects.toThrow(BadGatewayException);
    });

    it('should throw BadGatewayException when version is not 1', async () => {
      mockedAxios.get.mockResolvedValue({ data: { version: 2, sources: {}, tablePairs: [] } });
      const { service } = buildService();

      await expect(service.previewImport(WORKBOOK_ID, VALID_BODY, ACTOR)).rejects.toThrow(BadGatewayException);
    });

    it('should throw BadGatewayException when sources key is missing', async () => {
      mockedAxios.get.mockResolvedValue({ data: { version: 1, tablePairs: [] } });
      const { service } = buildService();

      await expect(service.previewImport(WORKBOOK_ID, VALID_BODY, ACTOR)).rejects.toThrow(BadGatewayException);
    });

    it('should throw BadGatewayException when tablePairs key is missing', async () => {
      mockedAxios.get.mockResolvedValue({ data: { version: 1, sources: {} } });
      const { service } = buildService();

      await expect(service.previewImport(WORKBOOK_ID, VALID_BODY, ACTOR)).rejects.toThrow(BadGatewayException);
    });
  });

  // ---------------------------------------------------------------------------
  // Error propagation from dependencies
  // ---------------------------------------------------------------------------
  describe('dependency error propagation', () => {
    it('should propagate NotFoundException when dataFolderService.listAll throws (workbook not found)', async () => {
      const wsExport = makeMinimalValidExport();
      mockedAxios.get.mockResolvedValue({ data: wsExport });

      const dataFolderService = {
        listAll: jest.fn().mockRejectedValue(new NotFoundException('Workbook not found')),
      } as unknown as DataFolderService;
      const configService = {
        getWhalesyncApiUrl: jest.fn().mockReturnValue('https://api.whalesync.com'),
      } as unknown as ScratchConfigService;
      const service = new WhalesyncImportApiService(dataFolderService, configService);

      await expect(service.previewImport(WORKBOOK_ID, VALID_BODY, ACTOR)).rejects.toThrow(NotFoundException);
    });
  });
});
