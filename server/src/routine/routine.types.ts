import { RoutineAction, RoutineStep } from '@spinner/shared-types';
import { CronExpressionParser } from 'cron-parser';
import { z } from 'zod';

/**
 * Minimum interval between routine schedule ticks. Routines run heavier multi-step
 * pipelines than standalone schedules, so they use a stricter floor (5 min) than the
 * generic `SCHEDULE_MIN_INTERVAL_MINUTES` (1 min) in the schedule module.
 */
export const ROUTINE_SCHEDULE_MIN_INTERVAL_MINUTES = 5;

/**
 * Maximum per-step timeout (seconds), keyed by action. Forward-looking: the value is
 * validated here but not enforced until the step executor lands (a later phase). Pull
 * actions get a longer ceiling than sync/plan actions (large full pulls take longer).
 */
export const ROUTINE_STEP_TIMEOUT_MAX_SECONDS: Record<RoutineAction, number> = {
  [RoutineAction.PULL]: 60 * 60,
  [RoutineAction.SYNC]: 30 * 60,
  [RoutineAction.PUBLISH_PLAN]: 30 * 60,
  [RoutineAction.PUBLISH]: 60 * 60,
};

/** The definition fields the parser extracts from a routine YAML file (no DB/run state). */
export interface ParsedRoutine {
  name: string;
  schedule: string | null;
  comment: string | null;
  steps: RoutineStep[];
}

/** Result of parsing a single routine file: either the parsed definition or a message. */
export type RoutineParseResult = { routine: ParsedRoutine } | { error: string };

/**
 * Validate a routine `schedule:` value. Returns an error message, or null when valid.
 * Routines require a 5-field cron with a ≥5-minute interval (see
 * {@link ROUTINE_SCHEDULE_MIN_INTERVAL_MINUTES}). Mirrors the two-tick interval check
 * in `ScheduleService.validateCronExpression`.
 */
export function validateRoutineCronExpression(schedule: string): string | null {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) {
    return 'schedule must be a 5-field cron expression (minute hour day-of-month month day-of-week)';
  }

  let parsed;
  try {
    parsed = CronExpressionParser.parse(schedule);
  } catch {
    return `invalid cron expression: ${schedule}`;
  }

  const first = parsed.next().toDate();
  const second = parsed.next().toDate();
  const intervalMinutes = (second.getTime() - first.getTime()) / 60_000;
  if (intervalMinutes < ROUTINE_SCHEDULE_MIN_INTERVAL_MINUTES) {
    return `schedule interval must be at least ${ROUTINE_SCHEDULE_MIN_INTERVAL_MINUTES} minutes (got ~${Math.round(
      intervalMinutes,
    )} minutes)`;
  }
  return null;
}

/** A step's `folder` must be a POSIX path ("/blog/posts") or a DataFolderId ("dfd_..."). */
function isValidStepFolder(folder: string): boolean {
  return folder.startsWith('/') || folder.startsWith('dfd_');
}

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
  connection: z.string().min(1).optional(),
  comment: z.string().optional(),
  timeout: z.number().int().positive().optional(),
});

export const routineYamlSchema = z
  .strictObject({
    name: z.string().min(1, 'name must be a non-empty string'),
    schedule: z.string().min(1).optional(),
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
    });

    if (routine.schedule !== undefined) {
      const scheduleError = validateRoutineCronExpression(routine.schedule);
      if (scheduleError) {
        ctx.addIssue({ code: 'custom', message: scheduleError, path: ['schedule'] });
      }
    }
  });

/** Convert a validated YAML object into the wire-shaped {@link ParsedRoutine} (undefined → null). */
export function toParsedRoutine(data: z.infer<typeof routineYamlSchema>): ParsedRoutine {
  return {
    name: data.name,
    schedule: data.schedule ?? null,
    comment: data.comment ?? null,
    steps: data.steps.map((step) => ({
      action: step.action,
      name: step.name ?? null,
      folder: step.folder ?? null,
      connection: step.connection ?? null,
      comment: step.comment ?? null,
      timeout: step.timeout ?? null,
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
