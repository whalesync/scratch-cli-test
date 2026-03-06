import { Storage } from '@google-cloud/storage';
import { Injectable } from '@nestjs/common';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';

export interface SaveObjectInput {
  key: string;
  buffer: Buffer;
  contentType: string;
  contentHash?: string;
}

export interface SaveObjectResult {
  publicUrl: string;
  key: string;
}

@Injectable()
export class ObjectStorageService {
  private storage: Storage;
  private bucket: string;

  constructor(private readonly config: ScratchConfigService) {
    const bucket = config.getGcsAssetBucket();
    if (!bucket) {
      WSLogger.warn({
        source: 'ObjectStorageService',
        message: 'GCS_ASSET_BUCKET not configured; asset rehosting disabled',
      });
    }
    this.bucket = bucket ?? '';

    const projectId = config.getGcsProjectId();
    this.storage = new Storage(projectId ? { projectId } : undefined);
  }

  isConfigured(): boolean {
    return this.bucket.length > 0;
  }

  async saveObject(input: SaveObjectInput): Promise<SaveObjectResult> {
    if (!this.isConfigured()) {
      throw new Error('ObjectStorageService: GCS_ASSET_BUCKET is not configured');
    }

    const file = this.storage.bucket(this.bucket).file(input.key);

    await file.save(input.buffer, {
      contentType: input.contentType,
      metadata: {
        cacheControl: 'public, max-age=31536000, immutable',
        ...(input.contentHash ? { contentHash: input.contentHash } : {}),
      },
    });

    const publicUrl = `https://storage.googleapis.com/${this.bucket}/${input.key}`;

    WSLogger.info({
      source: 'ObjectStorageService',
      message: 'Uploaded object to GCS',
      key: input.key,
      contentType: input.contentType,
      size: input.buffer.length,
    });

    return { publicUrl, key: input.key };
  }

  async objectExists(key: string): Promise<boolean> {
    if (!this.isConfigured()) {
      throw new Error('ObjectStorageService: GCS_ASSET_BUCKET is not configured');
    }

    const [exists] = await this.storage.bucket(this.bucket).file(key).exists();
    return exists;
  }
}
