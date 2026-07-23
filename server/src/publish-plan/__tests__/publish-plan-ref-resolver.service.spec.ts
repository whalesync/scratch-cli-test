import { Test, TestingModule } from '@nestjs/testing';
import { DbService } from '../../db/db.service';
import { FileIndexService } from '../file-index.service';
import { RefResolverService } from '../ref-resolver.service';

describe('PublishRefResolverService', () => {
  let service: RefResolverService;
  let fileIndexService: jest.Mocked<FileIndexService>;
  let connectorAccountFindMany: jest.Mock;

  // A single HubSpot connection in the workbook, whose folder name is "HubSpot".
  const HUBSPOT = { id: 'coa_hubspot', service: 'HUBSPOT', displayName: 'HubSpot' };
  // A second HubSpot connection ("HubSpot Testing") — the two-connections-share-a-
  // folder case. Distinct display name, so the connection segment disambiguates.
  const HUBSPOT_TESTING = { id: 'coa_hubspot_testing', service: 'HUBSPOT', displayName: 'HubSpot Testing' };
  // An Airtable connection that (coincidentally) has a top-level folder literally
  // named "HubSpot" — used to exercise the legacy-fallback path.
  const AIRTABLE = { id: 'coa_airtable', service: 'AIRTABLE', displayName: 'Airtable' };

  const setConnections = (accounts: { id: string; service: string; displayName: string }[]) => {
    connectorAccountFindMany.mockResolvedValue(accounts);
  };

  beforeEach(async () => {
    fileIndexService = {
      getRecordIds: jest.fn().mockResolvedValue(new Map()),
    } as unknown as jest.Mocked<FileIndexService>;

    connectorAccountFindMany = jest.fn().mockResolvedValue([]);

    const dbService = {
      client: {
        asset: {
          findMany: jest.fn().mockResolvedValue([]),
        },
        connectorAccount: {
          findMany: connectorAccountFindMany,
        },
      },
    } as unknown as jest.Mocked<DbService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefResolverService,
        { provide: FileIndexService, useValue: fileIndexService },
        { provide: DbService, useValue: dbService },
      ],
    }).compile();

    service = module.get<RefResolverService>(RefResolverService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('resolveBatchPseudoRefs', () => {
    const workbookId = 'wkb_test';

    it('should return operations unchanged if there are no pseudo refs', async () => {
      const operations = [{ name: 'Test', count: 1 }];
      const result = await service.resolveBatchPseudoRefs(workbookId, operations);

      expect(result).toEqual(operations);
      // No pseudo-refs → neither the connection-map query nor a FileIndex lookup
      // runs (the batch skips both on the publish dispatch hot path).
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fileIndexService.getRecordIds).not.toHaveBeenCalled();
      expect(connectorAccountFindMany).not.toHaveBeenCalled();
    });

    it('should strip the connection folder segment from a workspace-absolute ref and scope the lookup to that connection', async () => {
      setConnections([HUBSPOT]);
      fileIndexService.getRecordIds.mockResolvedValue(new Map([['Contacts:marcos.json', 'contact_123']]));

      const operations = [{ contactId: '@/HubSpot/Contacts/marcos.json', other: 'x' }];
      const result = await service.resolveBatchPseudoRefs(workbookId, operations, undefined, HUBSPOT.id);

      expect(result).toEqual([{ contactId: 'contact_123', other: 'x' }]);
      // The connection segment is stripped; the lookup is the connection-relative
      // remainder, scoped to the resolved connection.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fileIndexService.getRecordIds).toHaveBeenCalledWith(workbookId, [
        { folderPath: 'Contacts', filename: 'marcos.json', connectorAccountId: HUBSPOT.id },
      ]);
    });

    it('should route each ref to the right connection when two connections share a folder name', async () => {
      setConnections([HUBSPOT, HUBSPOT_TESTING]);
      fileIndexService.getRecordIds.mockResolvedValue(
        new Map([
          ['Contacts:a.json', 'contact_from_hubspot'],
          ['Contacts:b.json', 'contact_from_hubspot_testing'],
        ]),
      );

      // Publishing the "HubSpot" connection; one ref targets HubSpot, one targets
      // "HubSpot Testing" — both have a Contacts folder.
      const operations = [{ a: '@/HubSpot/Contacts/a.json', b: '@/HubSpot Testing/Contacts/b.json' }];
      const result = await service.resolveBatchPseudoRefs(workbookId, operations, undefined, HUBSPOT.id);

      expect(result).toEqual([{ a: 'contact_from_hubspot', b: 'contact_from_hubspot_testing' }]);

      const lookups = fileIndexService.getRecordIds.mock.calls[0][1];
      expect(lookups).toEqual(
        expect.arrayContaining([
          { folderPath: 'Contacts', filename: 'a.json', connectorAccountId: HUBSPOT.id },
          { folderPath: 'Contacts', filename: 'b.json', connectorAccountId: HUBSPOT_TESTING.id },
        ]),
      );
    });

    it('should treat a legacy connection-relative ref (no connection segment) as pointing at the plan connection', async () => {
      setConnections([HUBSPOT]);
      fileIndexService.getRecordIds.mockResolvedValue(new Map([['Contacts:marcos.json', 'contact_123']]));

      // No leading connection folder — the pre-DEV-10880 form.
      const operations = [{ contactId: '@/Contacts/marcos.json' }];
      const result = await service.resolveBatchPseudoRefs(workbookId, operations, undefined, HUBSPOT.id);

      expect(result).toEqual([{ contactId: 'contact_123' }]);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fileIndexService.getRecordIds).toHaveBeenCalledWith(workbookId, [
        { folderPath: 'Contacts', filename: 'marcos.json', connectorAccountId: HUBSPOT.id },
      ]);
    });

    it('should also accept the legacy "<SERVICE> - <displayName>" connection folder form', async () => {
      setConnections([HUBSPOT]);
      fileIndexService.getRecordIds.mockResolvedValue(new Map([['Contacts:marcos.json', 'contact_123']]));

      const operations = [{ contactId: '@/HUBSPOT - HubSpot/Contacts/marcos.json' }];
      const result = await service.resolveBatchPseudoRefs(workbookId, operations, undefined, HUBSPOT.id);

      expect(result).toEqual([{ contactId: 'contact_123' }]);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fileIndexService.getRecordIds).toHaveBeenCalledWith(workbookId, [
        { folderPath: 'Contacts', filename: 'marcos.json', connectorAccountId: HUBSPOT.id },
      ]);
    });

    it('should resolve pseudo refs inside arrays', async () => {
      setConnections([HUBSPOT]);
      fileIndexService.getRecordIds.mockResolvedValue(
        new Map([
          ['Tags:catA.json', 'record_catA'],
          ['Tags:catB.json', 'record_catB'],
        ]),
      );

      const operations = [{ items: ['normal_string', '@/HubSpot/Tags/catA.json', '@/HubSpot/Tags/catB.json'] }];
      const result = await service.resolveBatchPseudoRefs(workbookId, operations, undefined, HUBSPOT.id);

      expect(result).toEqual([{ items: ['normal_string', 'record_catA', 'record_catB'] }]);
    });

    it('should resolve pseudo refs deeply nested in objects', async () => {
      setConnections([HUBSPOT]);
      fileIndexService.getRecordIds.mockResolvedValue(new Map([['Departments:engineering.json', 'record_eng']]));

      const operations = [{ details: { organization: { departmentId: '@/HubSpot/Departments/engineering.json' } } }];
      const result = await service.resolveBatchPseudoRefs(workbookId, operations, undefined, HUBSPOT.id);

      expect(result).toEqual([{ details: { organization: { departmentId: 'record_eng' } } }]);
    });

    it('should only request unique refs across an entire batch', async () => {
      setConnections([HUBSPOT]);
      fileIndexService.getRecordIds.mockResolvedValue(
        new Map([
          ['Tags:tag1.json', 'record_tag1'],
          ['Tags:tag2.json', 'record_tag2'],
        ]),
      );

      const operations = [
        { tag: '@/HubSpot/Tags/tag1.json' },
        { tag: '@/HubSpot/Tags/tag2.json' },
        { tag: '@/HubSpot/Tags/tag1.json', metadata: { internalTag: '@/HubSpot/Tags/tag2.json' } },
      ];
      const result = await service.resolveBatchPseudoRefs(workbookId, operations, undefined, HUBSPOT.id);

      expect(result).toEqual([
        { tag: 'record_tag1' },
        { tag: 'record_tag2' },
        { tag: 'record_tag1', metadata: { internalTag: 'record_tag2' } },
      ]);

      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fileIndexService.getRecordIds).toHaveBeenCalledWith(workbookId, [
        { folderPath: 'Tags', filename: 'tag1.json', connectorAccountId: HUBSPOT.id },
        { folderPath: 'Tags', filename: 'tag2.json', connectorAccountId: HUBSPOT.id },
      ]);
    });

    it('falls back to the legacy interpretation when a legacy first segment coincides with a connection name', async () => {
      // Publishing the Airtable connection, which has a folder literally named
      // "HubSpot"; the workbook also has a HubSpot connection. A legacy ref
      // `@/HubSpot/rec.json` means the Airtable folder, but the first segment
      // matches the HubSpot connection. The primary (workspace-absolute) lookup
      // misses; the legacy fallback (plan connection + full path) resolves it.
      setConnections([HUBSPOT, AIRTABLE]);
      fileIndexService.getRecordIds
        .mockResolvedValueOnce(new Map()) // primary pass: `` / rec.json under HubSpot → miss
        .mockResolvedValueOnce(new Map([['HubSpot:rec.json', 'airtable_rec']])); // fallback: HubSpot/rec.json under Airtable

      const operations = [{ ref: '@/HubSpot/rec.json' }];
      const result = await service.resolveBatchPseudoRefs(workbookId, operations, undefined, AIRTABLE.id);

      expect(result).toEqual([{ ref: 'airtable_rec' }]);
      // Primary tried first (scoped to HubSpot, stripped folder), then the legacy
      // fallback (full path scoped to the Airtable plan connection).
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fileIndexService.getRecordIds).toHaveBeenNthCalledWith(1, workbookId, [
        { folderPath: '', filename: 'rec.json', connectorAccountId: HUBSPOT.id },
      ]);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fileIndexService.getRecordIds).toHaveBeenNthCalledWith(2, workbookId, [
        { folderPath: 'HubSpot', filename: 'rec.json', connectorAccountId: AIRTABLE.id },
      ]);
    });

    it('should throw an error naming the connection-relative folder/file if a pseudo ref cannot be resolved', async () => {
      setConnections([HUBSPOT]);
      fileIndexService.getRecordIds.mockResolvedValue(new Map());

      const operations = [{ failedId: '@/HubSpot/Missing/file.json' }];

      await expect(service.resolveBatchPseudoRefs(workbookId, operations, undefined, HUBSPOT.id)).rejects.toThrow(
        'Cannot resolve pseudo-ref "@/HubSpot/Missing/file.json": no record ID found in FileIndex for folder="Missing" file="file.json"',
      );
    });
  });

  describe('findUnresolvablePseudoRefs (DEV-10954)', () => {
    const workbookId = 'wkb_test';

    it('returns the refs that miss the FileIndex and omits those that resolve', async () => {
      setConnections([HUBSPOT]);
      // "marcos.json" resolves; "gone.json" does not (its target create failed / never landed).
      fileIndexService.getRecordIds.mockResolvedValue(new Map([['Contacts:marcos.json', 'contact_123']]));

      const contents = [{ a: '@/HubSpot/Contacts/marcos.json', b: '@/HubSpot/Contacts/gone.json' }];
      const unresolvable = await service.findUnresolvablePseudoRefs(workbookId, contents, HUBSPOT.id);

      expect([...unresolvable]).toEqual(['@/HubSpot/Contacts/gone.json']);
    });

    it('returns an empty set (and does no DB work) when the batch has no pseudo-refs', async () => {
      const unresolvable = await service.findUnresolvablePseudoRefs(workbookId, [{ name: 'plain' }], HUBSPOT.id);

      expect(unresolvable.size).toBe(0);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fileIndexService.getRecordIds).not.toHaveBeenCalled();
      expect(connectorAccountFindMany).not.toHaveBeenCalled();
    });

    it('returns an empty set when every ref resolves', async () => {
      setConnections([HUBSPOT]);
      fileIndexService.getRecordIds.mockResolvedValue(new Map([['Contacts:marcos.json', 'contact_123']]));

      const unresolvable = await service.findUnresolvablePseudoRefs(
        workbookId,
        [{ a: '@/HubSpot/Contacts/marcos.json' }],
        HUBSPOT.id,
      );

      expect(unresolvable.size).toBe(0);
    });
  });
});
