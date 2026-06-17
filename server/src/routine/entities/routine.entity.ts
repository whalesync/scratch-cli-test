import { RoutineRun as PrismaRoutineRun } from '@prisma/client';
import { Routine, ScheduleId } from '@spinner/shared-types';
import { RoutineParseResult } from '../routine.types';
import { RoutineRunEntity } from './routine-run.entity';

/**
 * Assembles the joined {@link Routine} returned by `GET /routines`: the parsed YAML
 * definition (or its parse error) merged with the file's schedule state and latest run.
 */
export const RoutineEntity = {
  build(args: {
    filePath: string;
    parseResult: RoutineParseResult;
    schedule: { id: ScheduleId; enabled: boolean } | null;
    latestRun: PrismaRoutineRun | null;
    /** Semantic warnings for a parsed routine's broken folder/connection references. Defaults to none. */
    referenceWarnings?: string[];
  }): Routine {
    const { filePath, parseResult, schedule, latestRun, referenceWarnings = [] } = args;

    const joined = {
      filePath,
      scheduleId: schedule?.id ?? null,
      scheduleEnabled: schedule?.enabled ?? null,
      latestRun: latestRun ? RoutineRunEntity.summaryFrom(latestRun) : null,
    };

    if ('error' in parseResult) {
      // Unparseable content has no steps to reference-check, so warnings are always empty here.
      return {
        ...joined,
        name: null,
        schedule: null,
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
      schedule: routine.schedule,
      comment: routine.comment,
      steps: routine.steps,
      parseError: null,
      referenceWarnings,
    };
  },
};
