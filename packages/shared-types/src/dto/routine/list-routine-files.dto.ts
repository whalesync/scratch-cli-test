import { z } from 'zod';

/** Query params for `GET /cli/v1/workbooks/:id/routines/files`. */
export const listRoutineFilesQuerySchema = z.object({
  /**
   * When true, omit `content` from every file (path + version + updatedAt only) — what
   * `scratchmd routines status` needs to detect server drift without downloading every file.
   * `z.stringbool` coerces the `?metadataOnly=true` query string to a boolean.
   */
  metadataOnly: z.stringbool().optional(),
});

export type ListRoutineFilesQueryDto = z.infer<typeof listRoutineFilesQuerySchema>;

/** One routine file as stored in Postgres, with its optimistic-concurrency version. */
export interface RoutineFileWithVersion {
  /** The routine file path, e.g. "routines/daily-sync.yaml". */
  path: string;
  /** `RoutineDefinition.version` — echo it back as `baseVersion` when pushing an edit to this file. */
  version: number;
  /** ISO-8601 timestamp of the last content change. */
  updatedAt: string;
  /** The verbatim YAML text. Absent when the request asked for `metadataOnly`. */
  content?: string;
}

/**
 * Response for `GET /cli/v1/workbooks/:id/routines/files` — every routine file of the
 * workbook straight from Postgres (DEV-11399). This is what an API-backed
 * `scratchmd routines pull` materializes locally; it replaces fetching the config git repo.
 */
export interface ListRoutineFilesResponse {
  files: RoutineFileWithVersion[];
}
