import { isDataFolderId, isSyncId, RoutineAction, RoutineStep } from '@spinner/shared-types';
import { z } from 'zod';

/**
 * Maximum per-step timeout (seconds), keyed by action. Validated here, and enforced by
 * RoutineExecutorService: an unspecified `timeout` defaults to this per-action max, and a
 * specified one is capped at it. Pull actions get a longer ceiling than sync/plan actions
 * (large full pulls take longer).
 */
export const ROUTINE_STEP_TIMEOUT_MAX_SECONDS: Record<RoutineAction, number> = {
  // Pre-flight cleanup is a fast local git reset per connection — a tight ceiling is plenty.
  [RoutineAction.DISCARD_PENDING_CHANGES]: 10 * 60,
  [RoutineAction.PULL]: 60 * 60,
  [RoutineAction.SYNC]: 30 * 60,
  [RoutineAction.PUBLISH_PLAN]: 30 * 60,
  [RoutineAction.PUBLISH]: 60 * 60,
};

/** The definition fields the parser extracts from a routine YAML file (no DB/run state). */
export interface ParsedRoutine {
  name: string;
  comment: string | null;
  steps: RoutineStep[];
  /**
   * True when the YAML still carried a (now-removed) `schedule:` key. Schedules are owned by the
   * Schedule DB table (action ROUTINE), not the YAML — the key is tolerated so existing files keep
   * parsing, but it is ignored here and surfaced as a non-blocking deprecation warning. See DEV-10478.
   */
  deprecatedScheduleFieldPresent: boolean;
}

/** Result of parsing a single routine file: either the parsed definition or a message. */
export type RoutineParseResult = { routine: ParsedRoutine } | { error: string };

/** One data folder, reduced to what reference validation needs. */
export interface ValidationFolder {
  /** DataFolderId ("dfd_..."). */
  id: string;
  /** Folder path, normalized to drop the leading slash that `DataFolder.path` stores. */
  path: string;
  /** The connection this folder belongs to, or null for an unlinked (scratch) folder. */
  connectorAccountId: string | null;
}

/** One connection, reduced to what reference validation needs. */
export interface ValidationConnection {
  /** ConnectorAccountId ("coa_..."). */
  id: string;
  /** The human-readable connection name (unique per workbook). */
  displayName: string;
}

/** One sync, reduced to what reference validation needs. */
export interface ValidationSync {
  /** SyncId ("syn_..."). */
  id: string;
  /** The human-readable sync name (used in error messages). */
  displayName: string;
}

/**
 * An in-memory snapshot of a workbook's data folders + connections, loaded once and reused
 * to validate one routine (create/update) or many (list/reload) without per-step queries.
 * Built by {@link RoutineReferenceValidatorService.loadContext}.
 */
export interface RoutineValidationContext {
  /** All folders keyed by normalized (no-leading-slash) path. A path may map to many folders (ambiguity across connections). */
  foldersByPath: Map<string, ValidationFolder[]>;
  /** All folders keyed by DataFolderId ("dfd_..."). */
  foldersById: Map<string, ValidationFolder>;
  /** All connections keyed by lowercased displayName (users hand-type names → case-insensitive match). */
  connectionsByName: Map<string, ValidationConnection>;
  /** All connections keyed by ConnectorAccountId ("coa_..."). */
  connectionsById: Map<string, ValidationConnection>;
  /** All syncs keyed by SyncId ("syn_..."). */
  syncsById: Map<string, ValidationSync>;
}

/** A step's `folder` must be a POSIX path ("/blog/posts") or a DataFolderId ("dfd_..."). */
function isValidStepFolder(folder: string): boolean {
  return folder.startsWith('/') || isDataFolderId(folder);
}

/** A step's `sync` must be a SyncId ("syn_..."). Syncs have auto-generated names, so only the id is accepted. */
function isValidStepSync(sync: string): boolean {
  return isSyncId(sync);
}

/**
 * Action-specific step config (the step's `options:` map). Strict so a typo'd option key is
 * rejected rather than silently ignored. New action options are declared here; per-action
 * validity (e.g. `fullPull` only on pull steps) is enforced in the step superRefine below.
 */
const routineStepOptionsSchema = z.strictObject({
  fullPull: z.boolean().optional(),
});

const routineStepYamlSchema = z.strictObject({
  action: z.nativeEnum(RoutineAction),
  // NOTE: the design's field table marks the routine-level `comment` as required, but its
  // own Validation Rules section and example YAML treat all comments as optional — we follow
  // the rules section and keep `comment` optional at both the routine and step level.
  name: z.string().min(1).optional(),
  folder: z
    .string()
    .min(1)
    .refine(isValidStepFolder, {
      message: "folder must be a POSIX path starting with '/' or a DataFolderId ('dfd_...')",
    })
    .optional(),
  folders: z
    .array(
      z.string().min(1).refine(isValidStepFolder, {
        message: "each folders entry must be a POSIX path starting with '/' or a DataFolderId ('dfd_...')",
      }),
    )
    .min(1, 'folders must list at least one folder')
    .optional(),
  connection: z.string().min(1).optional(),
  sync: z.string().min(1).refine(isValidStepSync, { message: "sync must be a SyncId ('syn_...')" }).optional(),
  comment: z.string().optional(),
  timeout: z.number().int().positive().optional(),
  options: routineStepOptionsSchema.optional(),
});

export const routineYamlSchema = z
  .strictObject({
    name: z.string().min(1, 'name must be a non-empty string'),
    // DEPRECATED and ignored: schedules are owned by the Schedule DB table (action ROUTINE), not the
    // YAML. The key is still accepted (rather than rejected by strictObject) so existing routine files
    // keep parsing and running; `toParsedRoutine` drops it and surfaces a deprecation warning. DEV-10478.
    schedule: z.string().optional(),
    comment: z.string().optional(),
    steps: z.array(routineStepYamlSchema).min(1, 'steps must contain at least one step'),
  })
  .superRefine((routine, ctx) => {
    const seenStepNames = new Set<string>();
    routine.steps.forEach((step, index) => {
      if (step.name) {
        if (seenStepNames.has(step.name)) {
          ctx.addIssue({
            code: 'custom',
            message: `duplicate step name "${step.name}" — step names must be unique within a routine`,
            path: ['steps', index, 'name'],
          });
        }
        seenStepNames.add(step.name);
      }

      if (step.timeout !== undefined) {
        const maxTimeoutSeconds = ROUTINE_STEP_TIMEOUT_MAX_SECONDS[step.action];
        if (step.timeout > maxTimeoutSeconds) {
          ctx.addIssue({
            code: 'custom',
            message: `timeout for "${step.action}" steps may not exceed ${maxTimeoutSeconds} seconds`,
            path: ['steps', index, 'timeout'],
          });
        }
      }

      // A sync step is addressed by its SyncId (folder/connection are meaningless for it); every
      // other action is addressed by folder/connection and must not carry a `sync`. Enforcing this
      // at the boundary keeps a user from quietly mis-targeting a step.
      if (step.action === RoutineAction.SYNC) {
        if (step.sync === undefined) {
          ctx.addIssue({
            code: 'custom',
            message: "sync steps require a 'sync' field (the SyncId to run)",
            path: ['steps', index, 'sync'],
          });
        }
        if (step.folder !== undefined) {
          ctx.addIssue({
            code: 'custom',
            message: "sync steps must not set 'folder' — target the sync via 'sync'",
            path: ['steps', index, 'folder'],
          });
        }
        if (step.folders !== undefined) {
          ctx.addIssue({
            code: 'custom',
            message: "sync steps must not set 'folders' — target the sync via 'sync'",
            path: ['steps', index, 'folders'],
          });
        }
        if (step.connection !== undefined) {
          ctx.addIssue({
            code: 'custom',
            message: "sync steps must not set 'connection' — target the sync via 'sync'",
            path: ['steps', index, 'connection'],
          });
        }
      } else if (step.sync !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `'sync' is only valid on sync steps (got a "${step.action}" step)`,
          path: ['steps', index, 'sync'],
        });
      }

      // Pull steps target a LIST of folders via `folders`; every other folder-addressed action
      // (publish / publish-plan) targets a SINGLE folder via `folder`. Keep the two fields from
      // crossing over so a user can't list many folders on a one-folder-one-job publish, or fall
      // back to the deprecated singular `folder` on a pull step.
      if (step.action === RoutineAction.PULL) {
        if (step.folder !== undefined) {
          ctx.addIssue({
            code: 'custom',
            message: "pull steps target folders via 'folders' (a list), not 'folder'",
            path: ['steps', index, 'folder'],
          });
        }
      } else if (step.action !== RoutineAction.SYNC && step.folders !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: `'folders' is only valid on pull steps (got a "${step.action}" step) — use 'folder' for a single target`,
          path: ['steps', index, 'folders'],
        });
      }

      // `fullPull` forces a full (re-fetch-everything) pull instead of the default incremental one,
      // which is meaningless for any non-pull action. Reject it so a user can't quietly set a no-op
      // option on a sync/publish step.
      if (step.options?.fullPull !== undefined && step.action !== RoutineAction.PULL) {
        ctx.addIssue({
          code: 'custom',
          message: `'fullPull' is only valid on pull steps (got a "${step.action}" step)`,
          path: ['steps', index, 'options', 'fullPull'],
        });
      }
    });
  });

/** Convert a validated YAML object into the wire-shaped {@link ParsedRoutine} (undefined → null). */
export function toParsedRoutine(data: z.infer<typeof routineYamlSchema>): ParsedRoutine {
  return {
    name: data.name,
    comment: data.comment ?? null,
    deprecatedScheduleFieldPresent: data.schedule !== undefined,
    steps: data.steps.map((step) => ({
      action: step.action,
      name: step.name ?? null,
      folder: step.folder ?? null,
      folders: step.folders ?? null,
      connection: step.connection ?? null,
      sync: step.sync ?? null,
      comment: step.comment ?? null,
      timeout: step.timeout ?? null,
      options: step.options ?? null,
    })),
  };
}

/** Render a zod validation error into a single concise, user-readable message. */
export function formatRoutineValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const location = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
      return `${location}${issue.message}`;
    })
    .join('; ');
}
