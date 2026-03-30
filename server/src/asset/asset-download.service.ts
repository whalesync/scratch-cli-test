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
const DEFAULT_BYTE_BUDGET = 200 * 1024 * 1024; // 200 MB max in-flight
const DEFAULT_MAX_CONCURRENCY = 25; // Upper bound on concurrent downloads
const DEFAULT_ESTIMATED_SIZE = 5 * 1024 * 1024; // 5 MB assumed for assets with unknown size

export interface RehostResult {
  assetId: string;
  success: boolean;
  rehostedUrl?: string;
  error?: string;
}

export interface RehostBatchOptions {
  /** Maximum bytes of in-flight downloads at any time. Default: 200MB. */
  byteBudget?: number;
  /** Maximum number of concurrent downloads regardless of byte budget. Default: 25. */
  maxConcurrency?: number;
  /** When false, only computes content hash without uploading to GCS. Default: true. */
  rehost?: boolean;
}

@Injectable()
export class AssetDownloadService {
  constructor(
    private readonly db: DbService,
    private readonly objectStorage: ObjectStorageService,
  ) {}

  /**
   * Download an asset from its source URL. When rehost=true (default), re-uploads to GCS.
   * When rehost=false, only computes and saves the content hash (no GCS upload).
   * Never throws — returns a result object with success/error info.
   */
  async downloadAndRehost(asset: Asset, options?: { rehost?: boolean }): Promise<RehostResult> {
    const shouldRehost = options?.rehost !== false;
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

      const response = await axios.get<ArrayBuffer>(asset.url, {
        responseType: 'arraybuffer',
        maxContentLength: MAX_CONTENT_LENGTH,
        timeout: DOWNLOAD_TIMEOUT,
      });

      const buffer = Buffer.from(response.data);
      const contentHash = createHash('sha256').update(buffer).digest('hex');

      if (shouldRehost) {
        const filename = this.resolveFilename(asset, parsedUrl);
        const hashedRemoteId = createHash('sha256').update(asset.remoteAssetId).digest('hex');
        const key = `v1/${asset.workbookId}/${asset.service}/${hashedRemoteId}/${filename}`;
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
            contentHash,
            urlExpiresAt: null,
          },
        });

        return { assetId: asset.id, success: true, rehostedUrl: publicUrl };
      } else {
        // Hash-only mode: save the hash without uploading to GCS
        await this.db.client.asset.update({
          where: { id: asset.id },
          data: { contentHash },
        });

        return { assetId: asset.id, success: true };
      }
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
   * Download and rehost a batch of assets with byte-budget concurrency control.
   * Launches concurrent downloads as long as estimated in-flight bytes stay under the budget.
   */
  async downloadAndRehostBatch(assets: Asset[], options?: RehostBatchOptions): Promise<RehostResult[]> {
    const byteBudget = options?.byteBudget ?? DEFAULT_BYTE_BUDGET;
    const maxConcurrency = options?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;

    const results: RehostResult[] = [];
    let inFlightBytes = 0;
    let inFlightCount = 0;
    let nextIndex = 0;

    return new Promise((resolve) => {
      const tryLaunchNext = () => {
        while (nextIndex < assets.length && inFlightCount < maxConcurrency) {
          const asset = assets[nextIndex];
          const estimatedSize = Number(asset.size) || DEFAULT_ESTIMATED_SIZE;

          // Allow at least one concurrent download even if it exceeds the budget
          if (inFlightCount > 0 && inFlightBytes + estimatedSize > byteBudget) {
            break;
          }

          inFlightBytes += estimatedSize;
          inFlightCount++;
          nextIndex++;

          void this.downloadAndRehost(asset, { rehost: options?.rehost }).then((result) => {
            results.push(result);
            inFlightBytes -= estimatedSize;
            inFlightCount--;

            if (results.length === assets.length) {
              const succeeded = results.filter((r) => r.success).length;
              WSLogger.info({
                source: 'AssetDownloadService',
                message: `Batch rehost complete: ${succeeded} succeeded, ${results.length - succeeded} failed out of ${results.length}`,
              });
              resolve(results);
            } else {
              tryLaunchNext();
            }
          });
        }
      };

      if (assets.length === 0) {
        resolve(results);
      } else {
        tryLaunchNext();
      }
    });
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
