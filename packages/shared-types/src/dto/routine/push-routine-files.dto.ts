import { z } from 'zod';
import { Routine } from '../../db/routine';

/**
 * A single routine file to create or overwrite. `path` must be a single
 * `.yaml`/`.yml` file directly under `routines/`; the server enforces that
 * boundary, validates the YAML, and checks every folder/connection reference
 * before writing anything.
 *
 * `baseVersion` is the per-file optimistic-concurrency token (DEV-11399): the
 * `RoutineDefinition.version` the client last pulled for this path, or `null`
 * to assert "I expect this file to be new". When present, the server refuses
 * the whole push with a `409 blocked_stale` if the stored version differs (the
 * file was edited or deleted server-side since the client pulled it). Omitting
 * it skips the guard for that file (what pre-DEV-11399 CLIs do).
 */
export const pushRoutineUpsertSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  baseVersion: z.number().int().min(1).nullable().optional(),
});

export type PushRoutineUpsertDto = z.infer<typeof pushRoutineUpsertSchema>;

/**
 * A routine file to delete, with the same per-file `baseVersion` guard as an
 * upsert. Deleting a path that no longer exists is a no-op, not a conflict.
 */
export const pushRoutineDeleteSchema = z.object({
  path: z.string().min(1),
  baseVersion: z.number().int().min(1).nullable().optional(),
});

export type PushRoutineDeleteDto = z.infer<typeof pushRoutineDeleteSchema>;

/**
 * Request body for `POST /cli/v1/workbooks/:id/routines/push` — the CLI's
 * batch push of routine files. The CLI diffs its local routine files and sends
 * the result as a set of upserts (created or edited files) and deletes.
 *
 * `deletes` accepts bare paths (what pre-DEV-11399 CLIs send — no per-file
 * guard) or `{ path, baseVersion }` objects.
 *
 * `baseHead` is the pre-DEV-11399 concurrency token: the CLI's local
 * config-repo `main` SHA. Routine definitions no longer live in git, so the
 * server IGNORES it (it logs a warning so we can see how many old binaries
 * remain) — honouring it against the lagging git mirror would produce false
 * conflicts. Use per-file `baseVersion` instead.
 *
 * @deprecated `baseHead` — ignored since DEV-11399; kept so older CLIs still parse.
 */
export const pushRoutineFilesSchema = z.object({
  upserts: z.array(pushRoutineUpsertSchema).default([]),
  deletes: z.array(z.union([z.string().min(1), pushRoutineDeleteSchema])).default([]),
  baseHead: z.string().nullable().optional(),
});

export type PushRoutineFilesDto = z.infer<typeof pushRoutineFilesSchema>;

/** The stored version of one routine file after a push (the token to echo as `baseVersion` next time). */
export interface RoutineFileVersion {
  path: string;
  version: number;
}

/**
 * Success response: every routine file's current version (the full post-push
 * set, not just the files this push touched, so the CLI can rewrite its local
 * manifest from one source), the full set of routines as reconciled by Reload
 * Routines, and — while the transitional git mirror is enabled — the
 * config-repo `main` SHA after the mirror commit so pre-DEV-11399 CLIs can
 * re-materialize their worktree. `head` is the empty string (never null: the
 * old CLI deserializes it as a non-nullable string and already treats "" as
 * "nothing to re-materialize") once the mirror is off or when it failed.
 */
export interface PushRoutineFilesResponse {
  files: RoutineFileVersion[];
  /** @deprecated Config-repo `main` SHA after the transitional git mirror commit; "" when the mirror is disabled or failed. */
  head: string;
  routines: Routine[];
}

/** One routine file whose `baseVersion` no longer matches what the server holds. */
export const pushRoutineStaleFileSchema = z.object({
  path: z.string(),
  /** What the client claimed to have (null = "expected new"). */
  baseVersion: z.number().int().nullable(),
  /** What the server holds now (null = the file no longer exists). */
  currentVersion: z.number().int().nullable(),
});

export type PushRoutineStaleFileDto = z.infer<typeof pushRoutineStaleFileSchema>;

/**
 * `409` response when at least one file's `baseVersion` is stale. Lists exactly
 * the stale files so the CLI can tell the user which routines to re-pull; the
 * push wrote nothing. Mirrors the upload-patch blocked-stale envelope.
 */
export const pushRoutineFilesBlockedStaleSchema = z.object({
  status: z.literal('blocked_stale'),
  staleFiles: z.array(pushRoutineStaleFileSchema),
  message: z.string(),
});

export type PushRoutineFilesBlockedStaleDto = z.infer<typeof pushRoutineFilesBlockedStaleSchema>;
