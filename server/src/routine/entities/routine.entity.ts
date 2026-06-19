import { RoutineRun as PrismaRoutineRun } from '@prisma/client';
import { Routine, ScheduleId } from '@spinner/shared-types';
import { RoutineParseResult } from '../routine.types';
import { RoutineRunEntity } from './routine-run.entity';

/**
 * Non-blocking warning surfaced when a routine file still carries a (now-removed) `schedule:` key.
 * The key is tolerated so existing files keep running, but it is ignored — the schedule is owned by
 * the Schedule DB table (action ROUTINE), edited from the Schedules panel. See DEV-10478.
 */
export const DEPRECATED_SCHEDULE_FIELD_WARNING =
  '`schedule:` in routine YAML is no longer used and is ignored — set the schedule from the Schedules panel instead.';

/**
 * Assembles the joined {@link Routine} returned by `GET /routines`: the parsed YAML definition (or its
 * parse error) merged with the file's schedule state and latest run. The cron + enabled state come from
 * the ROUTINE Schedule row (the YAML no longer carries a schedule); a leftover `schedule:` key adds
 * {@link DEPRECATED_SCHEDULE_FIELD_WARNING}.
 */
export const RoutineEntity = {
  build(args: {
    filePath: string;
    parseResult: RoutineParseResult;
    schedule: { id: ScheduleId; enabled: boolean; cronExpression: string } | null;
    latestRun: PrismaRoutineRun | null;
    /** Semantic warnings for a parsed routine's broken folder/connection references. Defaults to none. */
    referenceWarnings?: string[];
  }): Routine {
    const { filePath, parseResult, schedule, latestRun, referenceWarnings = [] } = args;

    const joined = {
      filePath,
      // The cron + enabled state now come from the ROUTINE Schedule row, not the YAML.
      schedule: schedule?.cronExpression ?? null,
      scheduleId: schedule?.id ?? null,
      scheduleEnabled: schedule?.enabled ?? null,
      latestRun: latestRun ? RoutineRunEntity.summaryFrom(latestRun) : null,
    };

    if ('error' in parseResult) {
      // Unparseable content has no steps to reference-check, so warnings are always empty here.
      return {
        ...joined,
        name: null,
        comment: null,
        steps: [],
        parseError: parseResult.error,
        referenceWarnings: [],
      };
    }

    const { routine } = parseResult;
    return {
      ...joined,
      name: routine.name,
      comment: routine.comment,
      steps: routine.steps,
      parseError: null,
      // Surface a leftover `schedule:` key as a non-blocking warning alongside any reference warnings,
      // so an ignored field isn't silently dropped.
      referenceWarnings: routine.deprecatedScheduleFieldPresent
        ? [DEPRECATED_SCHEDULE_FIELD_WARNING, ...referenceWarnings]
        : referenceWarnings,
    };
  },
};
