import { Storage } from '@google-cloud/storage';
import { Injectable } from '@nestjs/common';
import { CredentialBody, GoogleAuth, Impersonated } from 'google-auth-library';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import { Readable } from 'stream';
import { REHOSTED_ASSET_OBJECT_KEY_ROOT_PREFIX } from './asset.types';

/** Page size for listing the assets bucket (the GCS JSON API maximum). */
const ASSET_BUCKET_LIST_PAGE_SIZE = 1000;

/** One live object listed from the assets bucket. */
export interface AssetBucketLiveObjectListing {
  key: string;
  /** When this generation of the object was written, or null when GCS reported no parseable time. */
  timeCreatedOrNull: Date | null;
  /** The listed generation as GCS's decimal string (kept a string so it round-trips exactly), or null if absent. */
  generationOrNull: string | null;
}

/** What one generation-guarded delete of a live object in the assets bucket did. */
export type AssetBucketLiveObjectDeleteOutcome =
  /** The live object was deleted; bucket versioning keeps it as a recoverable noncurrent version. */
  | 'deleted'
  /** There was no live object at the key any more (HTTP 404). */
  | 'already-gone'
  /** The key now holds a different generation than the one listed (HTTP 412): it was re-uploaded since. */
  | 'changed-since-listed';

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
    const apiEndpoint = config.getGcsApiEndpoint();
    const localSigningSa = config.getGcsLocalSigningServiceAccount();
    if (localSigningSa) {
      // User-ADC dev fallback: `@google-cloud/storage`'s V4 URL signer calls
      // `auth.sign(blob)`, which throws `Cannot sign data without client_email`
      // when ADC is `authorized_user` type (i.e. `gcloud auth application-default
      // login` against a real human account). The `Impersonated` auth client
      // delegates `sign()` to IAM Credentials' `signBlob` API, which accepts
      // the user's bearer token plus a target SA the user has
      // `roles/iam.serviceAccountTokenCreator` on. In Cloud Run, ADC IS the
      // runtime SA — no impersonation needed — so this branch only fires when
      // GCS_LOCAL_SIGNING_SA is explicitly set in .env.
      WSLogger.info({
        source: 'ObjectStorageService',
        message: 'Using impersonated signing service account for GCS V4 signed URLs',
        data: { signingServiceAccount: localSigningSa },
      });
      // Construct the source auth and impersonation lazily on first use. The
      // Storage SDK calls `getClient()` on demand and caches; building the
      // impersonated client eagerly would require turning the constructor
      // into an async fn, which Nest doesn't support for providers.
      this.storage = new Storage({
        ...(projectId ? { projectId } : {}),
        ...(apiEndpoint ? { apiEndpoint } : {}),
        authClient: makeImpersonatedGoogleAuth(localSigningSa, projectId),
      });
    } else {
      this.storage = new Storage({
        ...(projectId ? { projectId } : {}),
        ...(apiEndpoint ? { apiEndpoint } : {}),
      });
    }
  }

  isConfigured(): boolean {
    return this.bucket.length > 0;
  }

  /** True when GCS_PATCH_UPLOAD_BUCKET is configured. /upload-patch is disabled when false. */
  isPatchUploadConfigured(): boolean {
    return this.patchUploadBucket.length > 0;
  }

  /**
   * Every rehosted object is publicly served at this prefix + its key. `saveObject` builds `rehostedUrl`s from
   * it and the rehosted-asset reaper matches `Asset` rows against it, so building and matching can't drift.
   */
  buildPublicUrlPrefixForAssetBucket(): string {
    this.assertAssetBucketConfigured();
    return `https://storage.googleapis.com/${this.bucket}/`;
  }

  async saveObject(input: SaveObjectInput): Promise<SaveObjectResult> {
    this.assertAssetBucketConfigured();

    const file = this.storage.bucket(this.bucket).file(input.key);

    await file.save(input.buffer, {
      contentType: input.contentType,
      metadata: {
        cacheControl: 'public, max-age=31536000, immutable',
        ...(input.contentHash ? { contentHash: input.contentHash } : {}),
      },
    });

    const publicUrl = `${this.buildPublicUrlPrefixForAssetBucket()}${input.key}`;

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
    this.assertAssetBucketConfigured();

    const [exists] = await this.storage.bucket(this.bucket).file(key).exists();
    return exists;
  }

  /**
   * The workbook-level key prefixes (`v1/{segment}/`) directly under the rehosted-asset key root, in GCS's
   * lexicographic order. A delimiter listing, so it reads one entry per prefix rather than every object.
   */
  async listWorkbookKeyPrefixesInAssetBucket(): Promise<string[]> {
    this.assertAssetBucketConfigured();

    const workbookKeyPrefixes: string[] = [];
    let pageToken: string | undefined;
    do {
      const [, , apiResponse] = await this.storage.bucket(this.bucket).getFiles({
        prefix: REHOSTED_ASSET_OBJECT_KEY_ROOT_PREFIX,
        delimiter: '/',
        autoPaginate: false,
        maxResults: ASSET_BUCKET_LIST_PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
      });
      const objectsListPage = readGcsObjectsListApiResponsePage(apiResponse);
      workbookKeyPrefixes.push(...objectsListPage.prefixes);
      pageToken = objectsListPage.nextPageToken;
    } while (pageToken);
    return workbookKeyPrefixes;
  }

  /**
   * Yields every LIVE object whose key starts with `keyPrefix`, one listing page at a time. Noncurrent versions
   * are never listed (`versions` stays unset), so nothing read here can point a delete at an old version.
   */
  async *listLiveObjectsInAssetBucketWithKeyPrefix(keyPrefix: string): AsyncGenerator<AssetBucketLiveObjectListing> {
    this.assertAssetBucketConfigured();

    let pageToken: string | undefined;
    do {
      const [files, , apiResponse] = await this.storage.bucket(this.bucket).getFiles({
        prefix: keyPrefix,
        autoPaginate: false,
        maxResults: ASSET_BUCKET_LIST_PAGE_SIZE,
        ...(pageToken ? { pageToken } : {}),
      });
      for (const file of files) {
        yield {
          key: file.name,
          timeCreatedOrNull: parseGcsTimestampOrNull(file.metadata.timeCreated),
          generationOrNull: file.metadata.generation === undefined ? null : String(file.metadata.generation),
        };
      }
      pageToken = readGcsObjectsListApiResponsePage(apiResponse).nextPageToken;
    } while (pageToken);
  }

  /**
   * Delete the LIVE object at `key`, but only while it is still the generation the caller listed
   * (`ifGenerationMatch`), so an object re-uploaded since the listing is left alone. In the versioned assets
   * bucket the delete turns the object into a noncurrent version that stays recoverable until the bucket's
   * lifecycle rule (plus soft delete) removes it.
   *
   * The object is deliberately addressed by key alone: passing a `generation` to `file()` would target that exact
   * version and delete it permanently, skipping the recovery window. Throws on any error other than 404 / 412.
   */
  async deleteLiveObjectFromAssetBucketIfGenerationMatches(
    key: string,
    listedGeneration: string,
  ): Promise<AssetBucketLiveObjectDeleteOutcome> {
    this.assertAssetBucketConfigured();

    try {
      await this.storage.bucket(this.bucket).file(key).delete({ ifGenerationMatch: listedGeneration });
      return 'deleted';
    } catch (error) {
      const httpStatusCode = readGcsApiErrorHttpStatusCode(error);
      if (httpStatusCode === 404) {
        return 'already-gone';
      }
      if (httpStatusCode === 412) {
        return 'changed-since-listed';
      }
      throw error;
    }
  }

  private assertAssetBucketConfigured(): void {
    if (!this.isConfigured()) {
      throw new Error('ObjectStorageService: GCS_ASSET_BUCKET is not configured');
    }
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

/**
 * Build a `GoogleAuth`-like object that the Storage SDK can use as `authClient`,
 * where `sign(blob)` is delegated to IAM Credentials' `signBlob` API against
 * the target service account. Used only in local-dev when ADC is user creds.
 *
 * The Storage SDK's `URLSigner.getSignedUrl` flow calls (in order):
 *   1. `authClient.getProjectId()` — for the canonical resource path
 *   2. `authClient.getCredentials()` — to read `client_email` (goes into the
 *      `X-Goog-Credential` query parameter)
 *   3. `authClient.sign(stringToSign)` — the actual RSA-SHA256 signature
 *
 * `Impersonated.sign()` returns `{ signedBlob, keyId }` where `signedBlob` is
 * base64; the Storage SDK expects a base64-encoded signature, so it Just Works
 * once we forward the call.
 */
function makeImpersonatedGoogleAuth(targetPrincipal: string, projectId: string | undefined): GoogleAuth {
  // We use a real `GoogleAuth` instance as the base so the Storage SDK's
  // downstream HTTP calls (which use `auth.request()`) still work for non-
  // signing operations like `createReadStream`. We override `getClient()` /
  // `getCredentials()` / `sign()` to return the impersonated client.
  const base = new GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    ...(projectId ? { projectId } : {}),
  });

  let cached: Promise<Impersonated> | undefined;
  const getImpersonated = (): Promise<Impersonated> => {
    if (!cached) {
      cached = (async () => {
        const sourceClient = await base.getClient();
        return new Impersonated({
          sourceClient,
          targetPrincipal,
          targetScopes: ['https://www.googleapis.com/auth/cloud-platform'],
          lifetime: 3600,
        });
      })();
    }
    return cached;
  };

  // Override the signing-related methods to delegate to the impersonated client.
  // Other methods on `base` are left intact so the Storage SDK's non-signing
  // operations (read/write blobs) still work via the user's ADC token.
  const originalGetCredentials = base.getCredentials.bind(base);
  base.sign = async (data: string): Promise<string> => {
    const imp = await getImpersonated();
    const resp = await imp.sign(data);
    return resp.signedBlob;
  };
  base.getCredentials = async (): Promise<CredentialBody> => {
    // The Storage SDK reads `client_email` from this to populate
    // `X-Goog-Credential`; that must match the SA that owns the signature.
    // Spread order matters: UserRefreshClient.getCredentials() resolves with
    // an object whose `client_email` is explicitly `undefined`, which would
    // overwrite our target if spread LAST. Put `client_email: targetPrincipal`
    // after the spread so it always wins.
    let underlying: CredentialBody = {};
    try {
      const result = await originalGetCredentials();
      if (result) underlying = result;
    } catch {
      // user ADC without client_email throws here — nothing to merge.
    }
    return { ...underlying, client_email: targetPrincipal };
  };
  return base;
}

/** The fields read from one page of a raw GCS `objects.list` JSON response. */
interface GcsObjectsListApiResponsePage {
  /** The "directory" prefixes, present when the listing used a delimiter. */
  prefixes: string[];
  nextPageToken: string | undefined;
}

/** `getFiles` types its raw API response as `unknown`; read the two fields we need without trusting its shape. */
function readGcsObjectsListApiResponsePage(apiResponse: unknown): GcsObjectsListApiResponsePage {
  if (typeof apiResponse !== 'object' || apiResponse === null) {
    return { prefixes: [], nextPageToken: undefined };
  }
  const prefixes =
    'prefixes' in apiResponse && Array.isArray(apiResponse.prefixes)
      ? apiResponse.prefixes.filter((prefix: unknown): prefix is string => typeof prefix === 'string')
      : [];
  const nextPageToken =
    'nextPageToken' in apiResponse &&
    typeof apiResponse.nextPageToken === 'string' &&
    apiResponse.nextPageToken.length > 0
      ? apiResponse.nextPageToken
      : undefined;
  return { prefixes, nextPageToken };
}

/** The HTTP status code a GCS `ApiError` carries as `code`, or undefined for any other error. */
function readGcsApiErrorHttpStatusCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'number') {
    return error.code;
  }
  return undefined;
}

/** A GCS RFC 3339 timestamp as a Date, or null when it's absent or unparseable. */
function parseGcsTimestampOrNull(timestamp: string | undefined): Date | null {
  if (!timestamp) {
    return null;
  }
  const parsedTimestamp = new Date(timestamp);
  return Number.isNaN(parsedTimestamp.getTime()) ? null : parsedTimestamp;
}
