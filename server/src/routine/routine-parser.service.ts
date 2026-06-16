import { Injectable } from '@nestjs/common';
import { load as loadYaml } from 'js-yaml';
import { formatRoutineValidationError, RoutineParseResult, routineYamlSchema, toParsedRoutine } from './routine.types';

/**
 * Parses and validates a single routine YAML file's contents. Pure and synchronous —
 * no database or git access — so it is trivially unit-testable and reusable.
 *
 * Returns a result union ({ routine } | { error }) rather than throwing, so a single
 * malformed file never aborts a whole `reload` / `GET routines` over many files.
 */
@Injectable()
export class RoutineParserService {
  parse(content: string): RoutineParseResult {
    let loaded: unknown;
    try {
      loaded = loadYaml(content);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { error: `Invalid YAML: ${reason}` };
    }

    if (loaded === null || loaded === undefined || typeof loaded !== 'object' || Array.isArray(loaded)) {
      return { error: 'Routine file must contain a YAML object with at least a "name" and "steps"' };
    }

    const result = routineYamlSchema.safeParse(loaded);
    if (!result.success) {
      return { error: formatRoutineValidationError(result.error) };
    }

    return { routine: toParsedRoutine(result.data) };
  }
}
