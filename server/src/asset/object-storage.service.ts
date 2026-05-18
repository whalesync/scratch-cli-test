import { Storage } from '@google-cloud/storage';
import { Injectable } from '@nestjs/common';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import { Readable } from 'stream';

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
  private patchUploadBucket: string;

  constructor(private readonly config: ScratchConfigService) {
    const bucket = config.getGcsAssetBucket();
    if (!bucket) {
      WSLogger.warn({
        source: 'ObjectStorageService',
        message: 'GCS_ASSET_BUCKET not configured; asset rehosting disabled',
      });
    }
    this.bucket = bucket ?? '';

    const patchUploadBucket = config.getGcsPatchUploadBucket();
    if (!patchUploadBucket) {
      WSLogger.warn({
        source: 'ObjectStorageService',
        message: 'GCS_PATCH_UPLOAD_BUCKET not configured; /upload-patch disabled',
      });
    }
    this.patchUploadBucket = patchUploadBucket ?? '';

    const projectId = config.getGcsProjectId();
    this.storage = new Storage(projectId ? { projectId } : undefined);
  }

  isConfigured(): boolean {
    return this.bucket.length > 0;
  }

  /** True when GCS_PATCH_UPLOAD_BUCKET is configured. /upload-patch is disabled when false. */
  isPatchUploadConfigured(): boolean {
    return this.patchUploadBucket.length > 0;
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

  /**
   * Generate a V4 presigned URL for a client to PUT a publish-patch payload
   * directly to GCS. Used by `/upload-patch/init` so big publishes bypass
   * NestJS body-parser limits.
   *
   * Pinned to `Content-Type: application/json` so the CLI MUST send that
   * header on its PUT — otherwise GCS rejects the request with 403 (signature
   * mismatch).
   */
  async signPutUrlForPatchUpload(key: string, expiresInSeconds: number): Promise<string> {
    if (!this.isPatchUploadConfigured()) {
      throw new Error('ObjectStorageService: GCS_PATCH_UPLOAD_BUCKET is not configured');
    }
    const [url] = await this.storage
      .bucket(this.patchUploadBucket)
      .file(key)
      .getSignedUrl({
        version: 'v4',
        action: 'write',
        expires: Date.now() + expiresInSeconds * 1000,
        contentType: 'application/json',
      });
    return url;
  }

  /**
   * Open a readable stream for a previously-uploaded patch payload. Used by
   * the ApplyPatchesJob worker to consume the payload without loading the
   * whole blob into memory.
   */
  streamObjectFromPatchUpload(key: string): Readable {
    if (!this.isPatchUploadConfigured()) {
      throw new Error('ObjectStorageService: GCS_PATCH_UPLOAD_BUCKET is not configured');
    }
    return this.storage.bucket(this.patchUploadBucket).file(key).createReadStream();
  }
}
