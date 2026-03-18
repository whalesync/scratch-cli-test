/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { Asset } from '@prisma/client';
import { Service } from '@spinner/shared-types';
import axios from 'axios';
import { createHash } from 'crypto';
import { AssetDownloadService, RehostResult } from '../asset-download.service';
import { ObjectStorageService } from '../object-storage.service';

jest.mock('axios');
const mockedAxios = jest.mocked(axios);

function makeAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: 'asset_1',
    createdAt: new Date(),
    updatedAt: new Date(),
    workbookId: 'wb_1',
    dataFolderId: 'dfd_1',
    service: Service.AIRTABLE,
    remoteAssetId: 'att_123',
    url: 'https://dl.airtable.com/photo.jpg',
    filename: 'photo.jpg',
    mimeType: 'image/jpeg',
    size: BigInt(1024),
    width: 800,
    height: 600,
    altText: null,
    mediaType: 'image',
    urlExpiresAt: new Date(Date.now() + 3600_000),
    lastSeenAt: new Date(),
    rehostedUrl: null,
    rehostedAt: null,
    ...overrides,
  };
}

function createMockDbService() {
  return {
    client: {
      asset: {
        update: jest.fn().mockResolvedValue({}),
      },
    },
  };
}

function createMockObjectStorage(): jest.Mocked<
  Pick<ObjectStorageService, 'saveObject' | 'objectExists' | 'isConfigured'>
> {
  return {
    saveObject: jest.fn().mockResolvedValue({ publicUrl: 'https://storage.googleapis.com/bucket/key', key: 'key' }),
    objectExists: jest.fn().mockResolvedValue(false),
    isConfigured: jest.fn().mockReturnValue(true),
  };
}

describe('AssetDownloadService', () => {
  let service: AssetDownloadService;
  let mockDb: ReturnType<typeof createMockDbService>;
  let mockStorage: ReturnType<typeof createMockObjectStorage>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDb = createMockDbService();
    mockStorage = createMockObjectStorage();
    service = new AssetDownloadService(mockDb as never, mockStorage as never);
  });

  describe('downloadAndRehost', () => {
    it('returns error when asset has no URL', async () => {
      const asset = makeAsset({ url: null });
      const result = await service.downloadAndRehost(asset);

      expect(result).toEqual<RehostResult>({
        assetId: 'asset_1',
        success: false,
        error: 'Asset has no URL',
      });
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('returns error when asset has invalid URL', async () => {
      const asset = makeAsset({ url: 'not-a-url' });
      const result = await service.downloadAndRehost(asset);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid URL');
      expect(mockedAxios.get).not.toHaveBeenCalled();
    });

    it('downloads, uploads, and updates DB on success', async () => {
      const asset = makeAsset();
      const fileContent = Buffer.from('fake image data');

      mockedAxios.get.mockResolvedValue({
        data: fileContent,
        headers: { 'content-type': 'image/jpeg' },
      });
      mockStorage.saveObject.mockResolvedValue({
        publicUrl: 'https://storage.googleapis.com/bucket/v1/wb_1/AIRTABLE/hash/photo.jpg',
        key: 'v1/wb_1/AIRTABLE/hash/photo.jpg',
      });

      const result = await service.downloadAndRehost(asset);

      expect(result.success).toBe(true);
      expect(result.rehostedUrl).toBe('https://storage.googleapis.com/bucket/v1/wb_1/AIRTABLE/hash/photo.jpg');

      // Verify axios was called with correct options
      expect(mockedAxios.get).toHaveBeenCalledWith(asset.url, {
        responseType: 'arraybuffer',
        maxContentLength: 100 * 1024 * 1024,
        timeout: 120_000,
      });

      // Verify upload was called with correct content hash
      const saveCall = mockStorage.saveObject.mock.calls[0][0];
      expect(saveCall.contentType).toBe('image/jpeg');
      expect(saveCall.contentHash).toBe(createHash('sha256').update(fileContent).digest('hex'));
      expect(saveCall.key).toContain('v1/wb_1/AIRTABLE/');
      expect(saveCall.key).toContain('/photo.jpg');

      // Verify DB update
      expect(mockDb.client.asset.update).toHaveBeenCalledWith({
        where: { id: 'asset_1' },
        data: {
          rehostedUrl: 'https://storage.googleapis.com/bucket/v1/wb_1/AIRTABLE/hash/photo.jpg',
          rehostedAt: expect.any(Date),
          urlExpiresAt: null,
        },
      });
    });

    it('returns error on download failure without throwing', async () => {
      const asset = makeAsset();
      mockedAxios.get.mockRejectedValue(new Error('Network timeout'));

      const result = await service.downloadAndRehost(asset);

      expect(result).toEqual<RehostResult>({
        assetId: 'asset_1',
        success: false,
        error: 'Network timeout',
      });
      expect(mockStorage.saveObject).not.toHaveBeenCalled();
      expect(mockDb.client.asset.update).not.toHaveBeenCalled();
    });

    it('returns error on upload failure without throwing', async () => {
      const asset = makeAsset();
      mockedAxios.get.mockResolvedValue({
        data: Buffer.from('data'),
        headers: { 'content-type': 'image/jpeg' },
      });
      mockStorage.saveObject.mockRejectedValue(new Error('GCS permission denied'));

      const result = await service.downloadAndRehost(asset);

      expect(result).toEqual<RehostResult>({
        assetId: 'asset_1',
        success: false,
        error: 'GCS permission denied',
      });
      expect(mockDb.client.asset.update).not.toHaveBeenCalled();
    });

    it('uses URL basename when filename is missing', async () => {
      const asset = makeAsset({ filename: null, url: 'https://example.com/path/to/document.pdf' });
      mockedAxios.get.mockResolvedValue({
        data: Buffer.from('data'),
        headers: { 'content-type': 'application/pdf' },
      });

      await service.downloadAndRehost(asset);

      const saveCall = mockStorage.saveObject.mock.calls[0][0];
      expect(saveCall.key).toContain('/document.pdf');
    });

    it('falls back to remoteAssetId with guessed extension when no filename or URL path', async () => {
      const asset = makeAsset({ filename: null, url: 'https://example.com/', mimeType: 'image/png' });
      mockedAxios.get.mockResolvedValue({
        data: Buffer.from('data'),
        headers: { 'content-type': 'image/png' },
      });

      await service.downloadAndRehost(asset);

      const saveCall = mockStorage.saveObject.mock.calls[0][0];
      expect(saveCall.key).toContain('/att_123.png');
    });

    it('uses response content-type when asset mimeType is null', async () => {
      const asset = makeAsset({ mimeType: null });
      mockedAxios.get.mockResolvedValue({
        data: Buffer.from('data'),
        headers: { 'content-type': 'image/webp' },
      });

      await service.downloadAndRehost(asset);

      const saveCall = mockStorage.saveObject.mock.calls[0][0];
      expect(saveCall.contentType).toBe('image/webp');
    });
  });

  describe('key generation', () => {
    it('is deterministic — same input produces same key', async () => {
      const asset = makeAsset();
      const fileContent = Buffer.from('fake data');
      mockedAxios.get.mockResolvedValue({
        data: fileContent,
        headers: { 'content-type': 'image/jpeg' },
      });

      await service.downloadAndRehost(asset);
      const key1 = mockStorage.saveObject.mock.calls[0][0].key;

      mockStorage.saveObject.mockClear();
      mockedAxios.get.mockResolvedValue({
        data: fileContent,
        headers: { 'content-type': 'image/jpeg' },
      });

      await service.downloadAndRehost(asset);
      const key2 = mockStorage.saveObject.mock.calls[0][0].key;

      expect(key1).toBe(key2);
    });
  });

  describe('filename sanitization', () => {
    it('strips unsafe characters from filename', async () => {
      const asset = makeAsset({ filename: 'my file (copy)!@#.jpg' });
      mockedAxios.get.mockResolvedValue({
        data: Buffer.from('data'),
        headers: { 'content-type': 'image/jpeg' },
      });

      await service.downloadAndRehost(asset);

      const saveCall = mockStorage.saveObject.mock.calls[0][0];
      // Unsafe chars should be replaced with underscores
      expect(saveCall.key).toMatch(/[a-zA-Z0-9._/-]+$/);
      expect(saveCall.key).not.toMatch(/[!@#() ]/);
    });
  });

  describe('downloadAndRehostBatch', () => {
    it('processes all assets and continues on individual failures', async () => {
      const assets = [
        makeAsset({ id: 'a1', url: 'https://example.com/1.jpg' }),
        makeAsset({ id: 'a2', url: null }), // will fail
        makeAsset({ id: 'a3', url: 'https://example.com/3.jpg' }),
      ];

      mockedAxios.get.mockResolvedValue({
        data: Buffer.from('data'),
        headers: { 'content-type': 'image/jpeg' },
      });

      const results = await service.downloadAndRehostBatch(assets);

      expect(results).toHaveLength(3);
      expect(results.find((r) => r.assetId === 'a1')?.success).toBe(true);
      expect(results.find((r) => r.assetId === 'a2')?.success).toBe(false);
      expect(results.find((r) => r.assetId === 'a3')?.success).toBe(true);
    });

    it('respects concurrency option', async () => {
      const assets = Array.from({ length: 7 }, (_, i) =>
        makeAsset({ id: `a${i}`, url: `https://example.com/${i}.jpg` }),
      );

      let maxConcurrent = 0;
      let currentConcurrent = 0;

      mockedAxios.get.mockImplementation(async () => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        currentConcurrent--;
        return { data: Buffer.from('data'), headers: { 'content-type': 'image/jpeg' } };
      });

      await service.downloadAndRehostBatch(assets, { concurrency: 3 });

      expect(maxConcurrent).toBeLessThanOrEqual(3);
    });
  });
});
