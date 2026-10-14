import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import { AssetBucketLiveObjectListing, ObjectStorageService } from '../object-storage.service';

const mockGetFiles = jest.fn();
const mockFileSave = jest.fn();
const mockFileDelete = jest.fn();
const mockFile = jest.fn((name: string) => ({ name, save: mockFileSave, delete: mockFileDelete }));
const mockBucket = jest.fn(() => ({ getFiles: mockGetFiles, file: mockFile }));

jest.mock('@google-cloud/storage', () => ({
  Storage: jest.fn().mockImplementation(() => ({ bucket: mockBucket })),
}));

const ASSET_BUCKET = 'test-assets';

/** `null` means GCS_ASSET_BUCKET is unset (an `undefined` argument would fall back to the default bucket). */
function makeService(assetBucket: string | null = ASSET_BUCKET): ObjectStorageService {
  const config = {
    getGcsAssetBucket: () => assetBucket ?? undefined,
    getGcsPatchUploadBucket: () => undefined,
    getGcsProjectId: () => undefined,
    getGcsApiEndpoint: () => undefined,
    getGcsLocalSigningServiceAccount: () => undefined,
  } as unknown as ScratchConfigService;
  return new ObjectStorageService(config);
}

function gcsApiError(httpStatusCode: number): Error {
  return Object.assign(new Error(`GCS error ${httpStatusCode}`), { code: httpStatusCode });
}

async function collectListing(listing: AsyncGenerator<AssetBucketLiveObjectListing>) {
  const listedObjects: AssetBucketLiveObjectListing[] = [];
  for await (const listedObject of listing) {
    listedObjects.push(listedObject);
  }
  return listedObjects;
}

describe('ObjectStorageService (assets bucket)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(WSLogger, 'info').mockImplementation();
    jest.spyOn(WSLogger, 'warn').mockImplementation();
  });
  afterEach(() => jest.restoreAllMocks());

  it('serves saved objects at the public URL prefix the reaper matches against', async () => {
    const service = makeService();
    mockFileSave.mockResolvedValue(undefined);

    const { publicUrl } = await service.saveObject({
      key: 'v1/wkb_AAAAAAAAAA/AIRTABLE/0123abcd/photo.jpg',
      buffer: Buffer.from('bytes'),
      contentType: 'image/jpeg',
    });

    expect(service.buildPublicUrlPrefixForAssetBucket()).toBe('https://storage.googleapis.com/test-assets/');
    expect(publicUrl).toBe(
      `${service.buildPublicUrlPrefixForAssetBucket()}v1/wkb_AAAAAAAAAA/AIRTABLE/0123abcd/photo.jpg`,
    );
  });

  it('lists the workbook key prefixes under v1/ across pages with a delimiter listing', async () => {
    const service = makeService();
    mockGetFiles
      .mockResolvedValueOnce([[], null, { prefixes: ['v1/wkb_AAAAAAAAAA/'], nextPageToken: 'page-2' }])
      .mockResolvedValueOnce([[], null, { prefixes: ['v1/wkb_BBBBBBBBBB/', 42] }]);

    const workbookKeyPrefixes = await service.listWorkbookKeyPrefixesInAssetBucket();

    expect(workbookKeyPrefixes).toEqual(['v1/wkb_AAAAAAAAAA/', 'v1/wkb_BBBBBBBBBB/']);
    expect(mockBucket).toHaveBeenCalledWith(ASSET_BUCKET);
    expect(mockGetFiles).toHaveBeenNthCalledWith(1, {
      prefix: 'v1/',
      delimiter: '/',
      autoPaginate: false,
      maxResults: 1000,
    });
    expect(mockGetFiles).toHaveBeenNthCalledWith(2, {
      prefix: 'v1/',
      delimiter: '/',
      autoPaginate: false,
      maxResults: 1000,
      pageToken: 'page-2',
    });
  });

  it('treats a listing response without prefixes as an empty listing', async () => {
    const service = makeService();
    mockGetFiles.mockResolvedValueOnce([[], null, undefined]);

    await expect(service.listWorkbookKeyPrefixesInAssetBucket()).resolves.toEqual([]);
  });

  it('yields live objects page by page, never listing noncurrent versions', async () => {
    const service = makeService();
    mockGetFiles
      .mockResolvedValueOnce([
        [
          {
            name: 'v1/wkb_AAAAAAAAAA/a.jpg',
            metadata: { timeCreated: '2026-03-31T10:00:00.000Z', generation: '1711879200000001' },
          },
        ],
        null,
        { nextPageToken: 'page-2' },
      ])
      .mockResolvedValueOnce([
        [
          { name: 'v1/wkb_AAAAAAAAAA/b.jpg', metadata: { timeCreated: '2026-04-01T10:00:00.000Z', generation: 7 } },
          { name: 'v1/wkb_AAAAAAAAAA/c.jpg', metadata: { timeCreated: 'not a timestamp' } },
        ],
        null,
        {},
      ]);

    const listedObjects = await collectListing(service.listLiveObjectsInAssetBucketWithKeyPrefix('v1/wkb_AAAAAAAAAA/'));

    expect(listedObjects).toEqual([
      {
        key: 'v1/wkb_AAAAAAAAAA/a.jpg',
        timeCreatedOrNull: new Date('2026-03-31T10:00:00.000Z'),
        generationOrNull: '1711879200000001',
      },
      {
        key: 'v1/wkb_AAAAAAAAAA/b.jpg',
        timeCreatedOrNull: new Date('2026-04-01T10:00:00.000Z'),
        generationOrNull: '7',
      },
      { key: 'v1/wkb_AAAAAAAAAA/c.jpg', timeCreatedOrNull: null, generationOrNull: null },
    ]);
    expect(mockGetFiles).toHaveBeenCalledTimes(2);
    expect(mockGetFiles).toHaveBeenNthCalledWith(2, {
      prefix: 'v1/wkb_AAAAAAAAAA/',
      autoPaginate: false,
      maxResults: 1000,
      pageToken: 'page-2',
    });
    for (const getFilesCall of mockGetFiles.mock.calls as [Record<string, unknown>][]) {
      expect(getFilesCall[0]).not.toHaveProperty('versions');
    }
  });

  describe('deleteLiveObjectFromAssetBucketIfGenerationMatches', () => {
    it('deletes the live object by key alone, guarded by the listed generation', async () => {
      const service = makeService();
      mockFileDelete.mockResolvedValue([{}]);

      const deleteOutcome = await service.deleteLiveObjectFromAssetBucketIfGenerationMatches(
        'v1/wkb_AAAAAAAAAA/a.jpg',
        '1711879200000001',
      );

      expect(deleteOutcome).toBe('deleted');
      // No generation passed to file(): targeting a version would delete it permanently.
      expect(mockFile).toHaveBeenCalledWith('v1/wkb_AAAAAAAAAA/a.jpg');
      expect(mockFile.mock.calls[0]).toHaveLength(1);
      expect(mockFileDelete).toHaveBeenCalledWith({ ifGenerationMatch: '1711879200000001' });
    });

    it('reports a vanished object (404) as already gone and a re-uploaded one (412) as changed', async () => {
      const service = makeService();
      mockFileDelete.mockRejectedValueOnce(gcsApiError(404)).mockRejectedValueOnce(gcsApiError(412));

      await expect(service.deleteLiveObjectFromAssetBucketIfGenerationMatches('k', '1')).resolves.toBe('already-gone');
      await expect(service.deleteLiveObjectFromAssetBucketIfGenerationMatches('k', '1')).resolves.toBe(
        'changed-since-listed',
      );
    });

    it('rethrows any other error', async () => {
      const service = makeService();
      mockFileDelete.mockRejectedValueOnce(gcsApiError(403));

      await expect(service.deleteLiveObjectFromAssetBucketIfGenerationMatches('k', '1')).rejects.toThrow(
        'GCS error 403',
      );
    });
  });

  it('refuses to touch the assets bucket when GCS_ASSET_BUCKET is not configured', async () => {
    const service = makeService(null);

    expect(() => service.buildPublicUrlPrefixForAssetBucket()).toThrow('GCS_ASSET_BUCKET is not configured');
    await expect(service.listWorkbookKeyPrefixesInAssetBucket()).rejects.toThrow('GCS_ASSET_BUCKET is not configured');
    await expect(service.deleteLiveObjectFromAssetBucketIfGenerationMatches('k', '1')).rejects.toThrow(
      'GCS_ASSET_BUCKET is not configured',
    );
    expect(mockGetFiles).not.toHaveBeenCalled();
    expect(mockFileDelete).not.toHaveBeenCalled();
  });
});
