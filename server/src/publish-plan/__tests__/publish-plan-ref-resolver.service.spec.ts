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
  // An Airtable connection that (coincidentally) has a folder literally named "HubSpot" —
  // the case where a folder name collides with another connection's name.
  const AIRTABLE = { id: 'coa_airtable', service: 'AIRTABLE', displayName: 'Airtable' };

  const setConnections = (accounts: { id: string; service: string; displayName: string }[]) => {
    connectorAccountFindMany.mockResolvedValue(accounts);
  };

  beforeEach(async () => {
    fileIndexService = {
      getRecordIds: jest.fn().mockResolvedValue(new Map()),
      getRecordId: jest.fn().mockResolvedValue(null),
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
      fileIndexService.getRecordIds.mockResolvedValue(new Map([['coa_hubspot:Contacts:marcos.json', 'contact_123']]));

      const operations = [{ contactId: '@/HubSpot/Contacts/marcos.json', other: 'x' }];
      const result = await service.resolveBatchPseudoRefs(workbookId, operations);

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
          ['coa_hubspot:Contacts:a.json', 'contact_from_hubspot'],
          ['coa_hubspot_testing:Contacts:b.json', 'contact_from_hubspot_testing'],
        ]),
      );

      // Publishing the "HubSpot" connection; one ref targets HubSpot, one targets
      // "HubSpot Testing" — both have a Contacts folder.
      const operations = [{ a: '@/HubSpot/Contacts/a.json', b: '@/HubSpot Testing/Contacts/b.json' }];
      const result = await service.resolveBatchPseudoRefs(workbookId, operations);

      expect(result).toEqual([{ a: 'contact_from_hubspot', b: 'contact_from_hubspot_testing' }]);

      const lookups = fileIndexService.getRecordIds.mock.calls[0][1];
      expect(lookups).toEqual(
        expect.arrayContaining([
          { folderPath: 'Contacts', filename: 'a.json', connectorAccountId: HUBSPOT.id },
          { folderPath: 'Contacts', filename: 'b.json', connectorAccountId: HUBSPOT_TESTING.id },
        ]),
      );
    });

    // A reference that omits its connection folder has no second reading to fall back to —
    // it is a hard, diagnostic failure.
    it('REJECTS a ref that omits the connection folder, with a diagnostic error', async () => {
      setConnections([HUBSPOT]);
      fileIndexService.getRecordIds.mockResolvedValue(new Map([['coa_hubspot:Contacts:marcos.json', 'contact_123']]));

      const operations = [{ contactId: '@/Contacts/marcos.json' }];

      await expect(service.resolveBatchPseudoRefs(workbookId, operations)).rejects.toThrow(
        'Pseudo-ref "@/Contacts/marcos.json" is not workspace-absolute: "Contacts" is not a connection folder ' +
          'in this workspace (expected one of: HubSpot). Use "@/<connection>/<folder>/<file>.json".',
      );
      // It fails BEFORE any FileIndex work — there is nothing sensible to look up.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fileIndexService.getRecordIds).not.toHaveBeenCalled();
    });

    it('REJECTS a ref with no folder segment at all', async () => {
      setConnections([HUBSPOT]);

      await expect(service.resolveBatchPseudoRefs(workbookId, [{ contactId: '@/marcos.json' }])).rejects.toThrow(
        'is not workspace-absolute',
      );
    });

    it('should also accept the legacy "<SERVICE> - <displayName>" connection folder form', async () => {
      setConnections([HUBSPOT]);
      fileIndexService.getRecordIds.mockResolvedValue(new Map([['coa_hubspot:Contacts:marcos.json', 'contact_123']]));

      const operations = [{ contactId: '@/HUBSPOT - HubSpot/Contacts/marcos.json' }];
      const result = await service.resolveBatchPseudoRefs(workbookId, operations);

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
          ['coa_hubspot:Tags:catA.json', 'record_catA'],
          ['coa_hubspot:Tags:catB.json', 'record_catB'],
        ]),
      );

      const operations = [{ items: ['normal_string', '@/HubSpot/Tags/catA.json', '@/HubSpot/Tags/catB.json'] }];
      const result = await service.resolveBatchPseudoRefs(workbookId, operations);

      expect(result).toEqual([{ items: ['normal_string', 'record_catA', 'record_catB'] }]);
    });

    it('should resolve pseudo refs deeply nested in objects', async () => {
      setConnections([HUBSPOT]);
      fileIndexService.getRecordIds.mockResolvedValue(
        new Map([['coa_hubspot:Departments:engineering.json', 'record_eng']]),
      );

      const operations = [{ details: { organization: { departmentId: '@/HubSpot/Departments/engineering.json' } } }];
      const result = await service.resolveBatchPseudoRefs(workbookId, operations);

      expect(result).toEqual([{ details: { organization: { departmentId: 'record_eng' } } }]);
    });

    it('should only request unique refs across an entire batch', async () => {
      setConnections([HUBSPOT]);
      fileIndexService.getRecordIds.mockResolvedValue(
        new Map([
          ['coa_hubspot:Tags:tag1.json', 'record_tag1'],
          ['coa_hubspot:Tags:tag2.json', 'record_tag2'],
        ]),
      );

      const operations = [
        { tag: '@/HubSpot/Tags/tag1.json' },
        { tag: '@/HubSpot/Tags/tag2.json' },
        { tag: '@/HubSpot/Tags/tag1.json', metadata: { internalTag: '@/HubSpot/Tags/tag2.json' } },
      ];
      const result = await service.resolveBatchPseudoRefs(workbookId, operations);

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

    // There is exactly ONE reading: the first segment is the connection, full stop. A record
    // that really does live in an Airtable folder named "HubSpot" is addressed as
    // `@/Airtable/HubSpot/rec.json`, never as `@/HubSpot/rec.json`.
    it('reads the first segment as the connection even when a folder elsewhere shares that name', async () => {
      setConnections([HUBSPOT, AIRTABLE]);
      fileIndexService.getRecordIds.mockResolvedValue(new Map([['coa_airtable:HubSpot:rec.json', 'airtable_rec']]));

      const result = await service.resolveBatchPseudoRefs(workbookId, [{ ref: '@/Airtable/HubSpot/rec.json' }]);

      expect(result).toEqual([{ ref: 'airtable_rec' }]);
      // One lookup, scoped to Airtable — no second speculative pass.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fileIndexService.getRecordIds).toHaveBeenCalledTimes(1);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fileIndexService.getRecordIds).toHaveBeenCalledWith(workbookId, [
        { folderPath: 'HubSpot', filename: 'rec.json', connectorAccountId: AIRTABLE.id },
      ]);
    });

    describe('two connections sharing a folder name', () => {
      // Distinct display names that `sanitizeConnectionFolderName` collapses onto the SAME
      // folder name "HubSpot-Ops" (`:` is filesystem-reserved and becomes `-`), so the
      // leading segment alone cannot say which connection is meant.
      const OPS_A = { id: 'coa_ops_a', service: 'HUBSPOT', displayName: 'HubSpot-Ops' };
      const OPS_B = { id: 'coa_ops_b', service: 'HUBSPOT', displayName: 'HubSpot:Ops' };

      it('probes each claimant and resolves on the single one that holds the file', async () => {
        setConnections([OPS_A, OPS_B]);
        fileIndexService.getRecordId.mockImplementation(
          (_wkb: string, _folder: string, _file: string, connectorAccountId?: string | null) =>
            Promise.resolve(connectorAccountId === OPS_B.id ? 'rec_from_ops_b' : null),
        );

        const result = await service.resolveBatchPseudoRefs(workbookId, [
          { ref: '@/HubSpot-Ops/Contacts/marcos.json' },
        ]);

        expect(result).toEqual([{ ref: 'rec_from_ops_b' }]);
        // The bulk path can't answer this (its map key carries no connection), so it isn't used.
        // eslint-disable-next-line @typescript-eslint/unbound-method
        expect(fileIndexService.getRecordIds).not.toHaveBeenCalled();
      });

      it('throws naming BOTH connections when they both hold the file, rather than guessing', async () => {
        setConnections([OPS_A, OPS_B]);
        fileIndexService.getRecordId.mockImplementation(
          (_wkb: string, _folder: string, _file: string, connectorAccountId?: string | null) =>
            Promise.resolve(connectorAccountId === OPS_A.id ? 'rec_a' : 'rec_b'),
        );

        await expect(
          service.resolveBatchPseudoRefs(workbookId, [{ ref: '@/HubSpot-Ops/Contacts/marcos.json' }]),
        ).rejects.toThrow(/is ambiguous: connections "HubSpot-Ops" and "HubSpot:Ops" both use that folder name/);
      });

      it('reports a ref no claimant holds as unresolvable, not ambiguous', async () => {
        setConnections([OPS_A, OPS_B]);
        fileIndexService.getRecordId.mockResolvedValue(null);

        await expect(
          service.resolveBatchPseudoRefs(workbookId, [{ ref: '@/HubSpot-Ops/Contacts/marcos.json' }]),
        ).rejects.toThrow('Cannot resolve pseudo-ref "@/HubSpot-Ops/Contacts/marcos.json"');
      });
    });

    it('should throw an error naming the connection-relative folder/file if a pseudo ref cannot be resolved', async () => {
      setConnections([HUBSPOT]);
      fileIndexService.getRecordIds.mockResolvedValue(new Map());

      const operations = [{ failedId: '@/HubSpot/Missing/file.json' }];

      await expect(service.resolveBatchPseudoRefs(workbookId, operations)).rejects.toThrow(
        'Cannot resolve pseudo-ref "@/HubSpot/Missing/file.json": no record ID found in FileIndex for folder="Missing" file="file.json"',
      );
    });
  });

  describe('findUnresolvablePseudoRefs (DEV-10954)', () => {
    const workbookId = 'wkb_test';

    it('returns the refs that miss the FileIndex and omits those that resolve', async () => {
      setConnections([HUBSPOT]);
      // "marcos.json" resolves; "gone.json" does not (its target create failed / never landed).
      fileIndexService.getRecordIds.mockResolvedValue(new Map([['coa_hubspot:Contacts:marcos.json', 'contact_123']]));

      const contents = [{ a: '@/HubSpot/Contacts/marcos.json', b: '@/HubSpot/Contacts/gone.json' }];
      const unresolvable = await service.findUnresolvablePseudoRefs(workbookId, contents);

      expect([...unresolvable]).toEqual(['@/HubSpot/Contacts/gone.json']);
    });

    it('returns an empty set (and does no DB work) when the batch has no pseudo-refs', async () => {
      const unresolvable = await service.findUnresolvablePseudoRefs(workbookId, [{ name: 'plain' }]);

      expect(unresolvable.size).toBe(0);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fileIndexService.getRecordIds).not.toHaveBeenCalled();
      expect(connectorAccountFindMany).not.toHaveBeenCalled();
    });

    it('returns an empty set when every ref resolves', async () => {
      setConnections([HUBSPOT]);
      fileIndexService.getRecordIds.mockResolvedValue(new Map([['coa_hubspot:Contacts:marcos.json', 'contact_123']]));

      const unresolvable = await service.findUnresolvablePseudoRefs(workbookId, [
        { a: '@/HubSpot/Contacts/marcos.json' },
      ]);

      expect(unresolvable.size).toBe(0);
    });
  });
});
