import { Injectable } from '@nestjs/common';
import { Asset } from '@prisma/client';
import axios from 'axios';
import { createHash } from 'crypto';
import { extname } from 'path';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { ObjectStorageService } from './object-storage.service';

const MAX_CONTENT_LENGTH = 100 * 1024 * 1024; // 100 MB
const DOWNLOAD_TIMEOUT = 120_000; // 120 seconds
const DEFAULT_CONCURRENCY = 5;

export interface RehostResult {
  assetId: string;
  success: boolean;
  rehostedUrl?: string;
  error?: string;
}

export interface RehostBatchOptions {
  concurrency?: number;
}

@Injectable()
export class AssetDownloadService {
  constructor(
    private readonly db: DbService,
    private readonly objectStorage: ObjectStorageService,
  ) {}

  /**
   * Download an asset from its source URL and re-upload to GCS for permanent hosting.
   * Never throws — returns a result object with success/error info.
   */
  async downloadAndRehost(asset: Asset): Promise<RehostResult> {
    try {
      if (!asset.url) {
        return { assetId: asset.id, success: false, error: 'Asset has no URL' };
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(asset.url);
      } catch {
        return { assetId: asset.id, success: false, error: `Invalid URL: ${asset.url}` };
      }

      const filename = this.resolveFilename(asset, parsedUrl);
      const hashedRemoteId = createHash('sha256').update(asset.remoteAssetId).digest('hex');
      const key = `v1/${asset.workbookId}/${asset.service}/${hashedRemoteId}/${filename}`;

      const response = await axios.get<ArrayBuffer>(asset.url, {
        responseType: 'arraybuffer',
        maxContentLength: MAX_CONTENT_LENGTH,
        timeout: DOWNLOAD_TIMEOUT,
      });

      const buffer = Buffer.from(response.data);
      const contentHash = createHash('sha256').update(buffer).digest('hex');
      const responseContentType =
        typeof response.headers['content-type'] === 'string' ? response.headers['content-type'] : undefined;
      const contentType = asset.mimeType ?? responseContentType ?? 'application/octet-stream';

      const { publicUrl } = await this.objectStorage.saveObject({
        key,
        buffer,
        contentType,
        contentHash,
      });

      await this.db.client.asset.update({
        where: { id: asset.id },
        data: {
          rehostedUrl: publicUrl,
          rehostedAt: new Date(),
          urlExpiresAt: null,
        },
      });

      return { assetId: asset.id, success: true, rehostedUrl: publicUrl };
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : typeof error === 'object' && error !== null
            ? JSON.stringify(error)
            : String(error);
      WSLogger.error({
        source: 'AssetDownloadService',
        message: `Failed to rehost asset ${asset.id}`,
        error: message,
      });
      return { assetId: asset.id, success: false, error: message };
    }
  }

  /**
   * Download and rehost a batch of assets with controlled concurrency.
   */
  async downloadAndRehostBatch(assets: Asset[], options?: RehostBatchOptions): Promise<RehostResult[]> {
    const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
    const results: RehostResult[] = [];

    for (let i = 0; i < assets.length; i += concurrency) {
      const chunk = assets.slice(i, i + concurrency);
      const settled = await Promise.allSettled(chunk.map((asset) => this.downloadAndRehost(asset)));

      for (const result of settled) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          // downloadAndRehost never throws, but handle just in case
          results.push({ assetId: 'unknown', success: false, error: String(result.reason) });
        }
      }
    }

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.length - succeeded;

    WSLogger.info({
      source: 'AssetDownloadService',
      message: `Batch rehost complete: ${succeeded} succeeded, ${failed} failed out of ${results.length}`,
    });

    return results;
  }

  /**
   * Resolve a safe filename for the asset.
   * Priority: asset.filename → URL path basename → fallback with remoteAssetId + guessed extension.
   */
  private resolveFilename(asset: Asset, parsedUrl: URL): string {
    let name: string | undefined;

    if (asset.filename) {
      name = asset.filename;
    } else {
      const urlBasename = parsedUrl.pathname.split('/').pop();
      if (urlBasename && urlBasename.length > 0 && urlBasename !== '/') {
        name = decodeURIComponent(urlBasename);
      }
    }

    if (!name) {
      const ext = this.guessExtension(asset.mimeType);
      name = `${asset.remoteAssetId}${ext}`;
    }

    return this.sanitizeFilename(name);
  }

  /**
   * Guess file extension from MIME type.
   */
  private guessExtension(mimeType: string | null | undefined): string {
    if (!mimeType) return '';

    const map: Record<string, string> = {
      'image/jpeg': '.jpg',
      'image/png': '.png',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/svg+xml': '.svg',
      'video/mp4': '.mp4',
      'audio/mpeg': '.mp3',
      'application/pdf': '.pdf',
    };

    return map[mimeType] ?? '';
  }

  /**
   * Sanitize filename to safe characters and limit length.
   */
  private sanitizeFilename(name: string): string {
    // Preserve extension
    const ext = extname(name);
    const base = name.slice(0, name.length - ext.length);

    const safeBase = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 255 - ext.length);
    const safeExt = ext.replace(/[^a-zA-Z0-9.]/g, '');

    return `${safeBase}${safeExt}`.slice(0, 255);
  }
}
