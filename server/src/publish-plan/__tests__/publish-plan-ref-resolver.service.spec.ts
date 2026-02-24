import { Test, TestingModule } from '@nestjs/testing';
import { FileIndexService } from '../file-index.service';
import { RefResolverService } from '../ref-resolver.service';

describe('PublishRefResolverService', () => {
  let service: RefResolverService;
  let fileIndexService: jest.Mocked<FileIndexService>;

  beforeEach(async () => {
    // Mock the FileIndexService
    fileIndexService = {
      getRecordIds: jest.fn(),
    } as unknown as jest.Mocked<FileIndexService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RefResolverService,
        {
          provide: FileIndexService,
          useValue: fileIndexService,
        },
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
      fileIndexService.getRecordIds.mockResolvedValue(new Map());

      const operations = [{ name: 'Test', count: 1 }];
      const result = await service.resolveBatchPseudoRefs(workbookId, operations);

      expect(result).toEqual(operations);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fileIndexService.getRecordIds).toHaveBeenCalledWith(workbookId, []);
    });

    it('should resolve a simple string pseudo ref', async () => {
      const dbMap = new Map<string, string>();
      dbMap.set('users:user1.json', 'record_user1');
      fileIndexService.getRecordIds.mockResolvedValue(dbMap);

      const operations = [{ userId: '@/users/user1.json', otherProp: 'test' }];
      const result = await service.resolveBatchPseudoRefs(workbookId, operations);

      expect(result).toEqual([{ userId: 'record_user1', otherProp: 'test' }]);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fileIndexService.getRecordIds).toHaveBeenCalledWith(workbookId, [
        { folderPath: 'users', filename: 'user1.json' },
      ]);
    });

    it('should resolve pseudo refs inside arrays', async () => {
      const dbMap = new Map<string, string>();
      dbMap.set('categories:catA.json', 'record_catA');
      dbMap.set('categories:catB.json', 'record_catB');
      fileIndexService.getRecordIds.mockResolvedValue(dbMap);

      const operations = [
        {
          items: ['normal_string', '@/categories/catA.json', '@/categories/catB.json'],
        },
      ];

      const result = await service.resolveBatchPseudoRefs(workbookId, operations);

      expect(result).toEqual([
        {
          items: ['normal_string', 'record_catA', 'record_catB'],
        },
      ]);
    });

    it('should resolve pseudo refs deeply nested in objects', async () => {
      const dbMap = new Map<string, string>();
      dbMap.set('dept:engineering.json', 'record_eng');
      fileIndexService.getRecordIds.mockResolvedValue(dbMap);

      const operations = [
        {
          details: {
            organization: {
              departmentId: '@/dept/engineering.json',
            },
          },
        },
      ];

      const result = await service.resolveBatchPseudoRefs(workbookId, operations);

      expect(result).toEqual([
        {
          details: {
            organization: {
              departmentId: 'record_eng',
            },
          },
        },
      ]);
    });

    it('should resolve multiple refs across an entire batch containing multiple operations', async () => {
      const dbMap = new Map<string, string>();
      dbMap.set('tags:tag1.json', 'record_tag1');
      dbMap.set('tags:tag2.json', 'record_tag2');
      fileIndexService.getRecordIds.mockResolvedValue(dbMap);

      const operations = [
        { tag: '@/tags/tag1.json' }, // Operation 1
        { tag: '@/tags/tag2.json' }, // Operation 2
        { tag: '@/tags/tag1.json', metadata: { internalTag: '@/tags/tag2.json' } }, // Operation 3 (duplicate refs)
      ];

      const result = await service.resolveBatchPseudoRefs(workbookId, operations);

      expect(result).toEqual([
        { tag: 'record_tag1' },
        { tag: 'record_tag2' },
        { tag: 'record_tag1', metadata: { internalTag: 'record_tag2' } },
      ]);

      // Ensure it only requests unique refs from the FileIndexService
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(fileIndexService.getRecordIds).toHaveBeenCalledWith(workbookId, [
        { folderPath: 'tags', filename: 'tag1.json' },
        { folderPath: 'tags', filename: 'tag2.json' },
      ]);
    });

    it('should throw an error if a pseudo ref cannot be resolved to a record ID', async () => {
      // Mock returns an empty map, so any lookups will fail
      fileIndexService.getRecordIds.mockResolvedValue(new Map());

      const operations = [{ failedId: '@/missing/file.json' }];

      await expect(service.resolveBatchPseudoRefs(workbookId, operations)).rejects.toThrow(
        'Cannot resolve pseudo-ref "@/missing/file.json": no record ID found in FileIndex for folder="missing" file="file.json"',
      );
    });
  });
});
