import { Injectable } from '@nestjs/common';
import { formatRecordJson, type UploadPatchPayload, type WorkbookId } from '@spinner/shared-types';
import { ObjectStorageService } from 'src/asset/object-storage.service';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { DIRTY_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { validateRecordPath } from 'src/utils/path-validation';
import { applyJsonPatch, isJsonPatchDialect } from './json-patch';

/** GCS key derived from an uploadId. Used by both the controller (PUT) and worker (stream). */
export function gcsKeyForPatchUpload(uploadId: string): string {
  return `upload-patches/${uploadId}.json`;
}

@Injectable()
export class ApplyPatchesService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
    private readonly objectStorageService: ObjectStorageService,
  ) {}

  /**
   * Stream patches from GCS and apply them to the dirty branch as one logical
   * change. Does NOT trigger publishing — callers (CLI / desktop) drive
   * `/publish-v2/plan-job` and `/run-job` themselves so the two concerns stay
   * decoupled. The endpoint's name (`/upload-patch/commit`) reflects this:
   * "commit patches to remote dirty", not "publish."
   */
  async applyPatches(args: {
    workbookId: WorkbookId;
    connectorAccountId: string;
    uploadId: string;
    onProgress?: (progress: { uploadId: string; patchCount: number; processedCount: number }) => Promise<void>;
  }): Promise<{ patchCount: number; postApplyDirtyHead: string | null }> {
    const { workbookId, connectorAccountId, uploadId, onProgress } = args;

    // 1. Stream + parse the patch payload.
    const payload = await this.readPatchPayload(uploadId);
    const patchCount = payload.patches.length;
    await onProgress?.({ uploadId, patchCount, processedCount: 0 });

    // 2. Resolve repo + load DataFolders for path validation.
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
    const dataFolders = await this.db.client.dataFolder.findMany({
      where: { workbookId, connectorAccountId },
      select: { path: true },
    });

    // 3. Validate every path BEFORE writing anything (all-or-nothing).
    const normalized: Array<{ path: string; patch: unknown; revert: boolean; kind?: string }> = [];
    for (const entry of payload.patches) {
      const safePath = validateRecordPath(
        entry.path,
        dataFolders.map((f) => ({ path: f.path ?? '' })),
      );
      normalized.push({ path: safePath, patch: entry.patch, revert: entry.revert === true, kind: entry.kind });
    }

    // 4. Split deletes from writes. A delete is the explicit `kind: "delete"`
    //    discriminator (v2 wire) or, for older clients that don't send `kind`, a
    //    null patch body — these agree, since a Delete entry always carries a
    //    null patch in both dialects.
    const toDelete: string[] = [];
    const toWrite: Array<{ path: string; patch: unknown }> = [];
    for (const entry of normalized) {
      if (entry.kind === 'delete' || entry.patch === null) toDelete.push(entry.path);
      else toWrite.push(entry);
    }

    // 5. Read existing dirty contents for writes (merge patches need a base).
    const filesToCommit: { path: string; content: string }[] = [];
    for (const entry of toWrite) {
      const existing = await this.scratchGitService.getRepoFile(repoId, DIRTY_BRANCH, entry.path);
      let base: unknown = {};
      if (existing) {
        try {
          base = JSON.parse(existing.content);
        } catch {
          // Unparseable existing file — overwrite with the patch.
          base = {};
        }
      }
      const next = applyUpdatePatch(base, entry.patch);
      if (next === null || typeof next !== 'object' || Array.isArray(next)) {
        throw new Error(`Patch result for ${entry.path} is not a JSON object — record files must serialize as objects`);
      }
      filesToCommit.push({
        path: entry.path,
        content: formatRecordJson(next as Record<string, unknown>),
      });
    }

    // 6. Apply writes + deletes to dirty. Each call is one commit on scratch-git's
    //    side; together they form a single logical "Apply patches" change. We
    //    intentionally chunk by operation type so scratch-git's API stays simple.
    if (filesToCommit.length > 0) {
      await this.scratchGitService.commitFilesToBranch(
        repoId,
        DIRTY_BRANCH,
        filesToCommit,
        `Apply patches (${filesToCommit.length}) via /upload-patch/commit`,
      );
    }
    if (toDelete.length > 0) {
      await this.scratchGitService.deleteFilesFromBranch(
        repoId,
        DIRTY_BRANCH,
        toDelete,
        `Delete files (${toDelete.length}) via /upload-patch/commit`,
      );
    }

    // 7. Persist per-path metadata from the upload-patch DTO into
    //    UploadPatchMeta. The dirty branch we just wrote carries file content
    //    only; flags like `revert: true` would otherwise be lost between this
    //    endpoint and the eventual publish job. Last upload wins (upsert per
    //    (workbook, account, path)), so a stale revert flag from an earlier
    //    upload is cleared the moment a non-revert upload edits the same
    //    path. Read by PublishPlanBuildService to set
    //    PublishPlanOperation.isRecreate; cleared after the publish lands.
    for (const entry of normalized) {
      await this.db.client.uploadPatchMeta.upsert({
        where: {
          workbookId_connectorAccountId_filePath: {
            workbookId,
            connectorAccountId,
            filePath: entry.path,
          },
        },
        create: {
          workbookId,
          connectorAccountId,
          filePath: entry.path,
          revert: entry.revert,
        },
        update: {
          revert: entry.revert,
        },
      });
    }

    // 8. Snapshot the dirty branch HEAD *after* this apply. The desktop carries
    //    this SHA to `/publish-v2/plan-job` as `expectedBaseDirtyHead` (DEV-10316
    //    TOCTOU token), and the plan build aborts if the connection's dirty HEAD
    //    has since drifted — proving the publish ships exactly what the user
    //    just uploaded and nothing the web sync staged in the meantime. Captured
    //    here, server-side, immediately after the commit so it can't include a
    //    concurrent writer's change.
    const postApplyDirtyHead = await this.scratchGitService.getBranchHead(repoId, DIRTY_BRANCH);

    await onProgress?.({ uploadId, patchCount, processedCount: patchCount });

    // Dialect telemetry for the migration rollout. `jsonPatchUpdates` counts RFC
    // 6902 (op-array) Update bodies; `legacyMergePatchUpdates` counts the v1
    // merge-patch Update bodies still being uploaded (distinguished from full
    // `Create` records by the explicit `kind`, when the client sends it). The v1
    // read path can be retired once these — and pre-`kind` clients — fall to ~0
    // across the fleet. DEV-10237.
    const jsonPatchUpdates = toWrite.filter((e) => Array.isArray(e.patch)).length;
    const legacyMergePatchUpdates = normalized.filter(
      (e) => e.kind === 'update' && e.patch !== null && typeof e.patch === 'object' && !Array.isArray(e.patch),
    ).length;

    WSLogger.info({
      source: 'ApplyPatchesService.applyPatches',
      message: 'Applied upload-patch payload to dirty branch',
      workbookId,
      data: {
        uploadId,
        patchCount,
        writes: filesToCommit.length,
        deletes: toDelete.length,
        revertCount: normalized.filter((p) => p.revert).length,
        payloadVersion: payload.version ?? 1,
        jsonPatchUpdates,
        legacyMergePatchUpdates,
        postApplyDirtyHead,
      },
    });

    return { patchCount, postApplyDirtyHead };
  }

  private async readPatchPayload(uploadId: string): Promise<UploadPatchPayload> {
    const stream = this.objectStorageService.streamObjectFromPatchUpload(gcsKeyForPatchUpload(uploadId));
    const buffers: Buffer[] = [];
    for await (const chunk of stream) {
      buffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array));
    }
    const text = Buffer.concat(buffers).toString('utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `Patch payload at upload ${uploadId} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error(`Patch payload at upload ${uploadId} must be an object with a "patches" array`);
    }
    const maybe = parsed as { patches?: unknown };
    if (!Array.isArray(maybe.patches)) {
      throw new Error(`Patch payload at upload ${uploadId} is missing the "patches" array`);
    }
    for (const entry of maybe.patches) {
      if (!entry || typeof entry !== 'object' || typeof (entry as { path?: unknown }).path !== 'string') {
        throw new Error(`Each patch entry must have a string "path"; got ${JSON.stringify(entry)}`);
      }
    }
    return parsed as UploadPatchPayload;
  }
}

/**
 * Apply an `Update` patch body onto a (dirty-branch) base, dispatching by
 * dialect: a 6902 op array (v2) goes through {@link applyJsonPatch}; a 7396
 * merge-patch object (v1) through {@link applyJsonMergePatch}. The patch body's
 * *shape* — not a wire version marker — selects the applier, mirroring the Rust
 * `json_patch::apply_update_patch`, so a fleet mid-rollout (v1 clients, v2
 * clients) all apply correctly.
 */
export function applyUpdatePatch(base: unknown, patch: unknown): unknown {
  return isJsonPatchDialect(patch)
    ? applyJsonPatch(base, patch as readonly unknown[])
    : applyJsonMergePatch(base, patch);
}

/**
 * RFC 7396 JSON Merge Patch — the legacy (v1) dialect, retained for the
 * dual-read window.
 *
 *   apply(target, patch):
 *     if patch is not an object:        return patch
 *     if target is not an object:       target = {}
 *     for each key k in patch:
 *       if patch[k] is null:            delete target[k]
 *       elif patch[k] is an object:     target[k] = apply(target[k], patch[k])
 *       else:                           target[k] = patch[k]
 *     return target
 *
 * Arrays are atomic per the spec. Its defining limitation — `null` overloaded as
 * the delete sentinel, so it cannot represent "set this field to null" — is why
 * new `Update` bodies are RFC 6902 (DEV-10237); see {@link applyJsonPatch}.
 */
export function applyJsonMergePatch(target: unknown, patch: unknown): unknown {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    return patch;
  }
  const base: Record<string, unknown> =
    target !== null && typeof target === 'object' && !Array.isArray(target)
      ? { ...(target as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) {
      delete base[key];
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      base[key] = applyJsonMergePatch(base[key], value);
    } else {
      base[key] = value;
    }
  }
  return base;
}
