import { Storage } from '@google-cloud/storage';
import { Injectable } from '@nestjs/common';
import { CredentialBody, GoogleAuth, Impersonated } from 'google-auth-library';
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
        authClient: makeImpersonatedGoogleAuth(localSigningSa, projectId),
      });
    } else {
      this.storage = new Storage(projectId ? { projectId } : undefined);
    }
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
