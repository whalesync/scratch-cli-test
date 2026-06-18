import { z } from 'zod';
import { Routine } from '../../db/routine';

/**
 * A single routine file to create or overwrite. `path` must be a single
 * `.yaml`/`.yml` file directly under `routines/`; the server enforces that
 * boundary, validates the YAML, and checks every folder/connection reference
 * before committing.
 */
export const pushRoutineUpsertSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export type PushRoutineUpsertDto = z.infer<typeof pushRoutineUpsertSchema>;

/**
 * Request body for `POST /cli/v1/workbooks/:id/routines/push` — the CLI's
 * batch push of routine files. The CLI diffs its local config-repo worktree
 * (scoped to `routines/`) and sends the result as a set of upserts (created or
 * edited files) and deletes (removed file paths).
 *
 * `baseHead` is the CLI's local config-repo `main` SHA at diff time. When
 * present, the server refuses the push with a `409 blocked_stale` if `main` has
 * advanced past it (another user/the server committed first), so a stale push
 * never blindly overwrites newer routines — the user is told to pull and retry.
 * Omitting `baseHead` skips the staleness guard (backward compatible).
 */
export const pushRoutineFilesSchema = z.object({
  upserts: z.array(pushRoutineUpsertSchema).default([]),
  deletes: z.array(z.string().min(1)).default([]),
  baseHead: z.string().nullable().optional(),
});

export type PushRoutineFilesDto = z.infer<typeof pushRoutineFilesSchema>;

/**
 * Success response: the new config-repo `main` SHA after the push, and the full
 * set of routines as reconciled by Reload Routines (schedules synced from the
 * just-committed files).
 */
export interface PushRoutineFilesResponse {
  head: string;
  routines: Routine[];
}

/**
 * `409` response when `baseHead` is stale. Mirrors the upload-patch
 * blocked-stale envelope so the CLI can discriminate the conflict and prompt a
 * `routines pull` before retrying.
 */
export const pushRoutineFilesBlockedStaleSchema = z.object({
  status: z.literal('blocked_stale'),
  baseHead: z.string().nullable(),
  currentRemoteHead: z.string(),
  message: z.string(),
});

export type PushRoutineFilesBlockedStaleDto = z.infer<typeof pushRoutineFilesBlockedStaleSchema>;
