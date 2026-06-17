import { RoutineAction } from '../enums/enums';
import { RoutineRunId, ScheduleId } from '../ids';
import { RoutineRunStatus, RoutineRunTrigger } from './routine-run';

///
/// A Routine is defined by a YAML file in the workbook config repo under routines/.
/// The definition is never stored in the database — these types describe what the
/// server parses out of the YAML and returns over the wire. See docs/routines-design.md.
///

/** A single step in a routine definition (parsed from the YAML `steps:` list). */
export interface RoutineStep {
  /** One of: pull | sync | publish-plan | publish. */
  action: RoutineAction;
  /** Optional human-readable label; unique within the routine when present. */
  name: string | null;
  /** Target folder: a POSIX path starting "/" or a DataFolderId ("dfd_..."). Null = all folders. */
  folder: string | null;
  /** Target connection name or id ("coa_..."). Null = all connections in the folder. */
  connection: string | null;
  /** Optional note for context. */
  comment: string | null;
  /** Optional per-step timeout in seconds. Parsed but not enforced until the executor lands. */
  timeout: number | null;
}

/** A compact summary of a routine's most recent run, for list/sidebar display. */
export interface RoutineRunSummary {
  id: RoutineRunId;
  status: RoutineRunStatus;
  trigger: RoutineRunTrigger;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/**
 * A routine as surfaced by `GET /workbooks/:id/routines`: the parsed YAML definition
 * joined with its schedule state and latest-run summary from the database.
 *
 * When the file fails to parse/validate, `parseError` is non-null and the parsed
 * fields are null/empty — the file path is always present so the UI can still list it.
 *
 * `parseError` and `referenceWarnings` are distinct: `parseError` means the YAML is
 * structurally invalid (and the parsed fields are blank), whereas `referenceWarnings`
 * flags a routine that parses fine but references data — a folder or connection — that
 * no longer exists in the workbook (e.g. a folder deleted after the routine was saved,
 * or a file pushed straight via git). Create/update reject such references outright, so
 * `referenceWarnings` is only ever populated on the read path (list/reload).
 */
export interface Routine {
  /** The routine file path within the config repo, e.g. "routines/daily-sync.yaml". */
  filePath: string;
  name: string | null;
  /** 5-field cron expression, or null for a manual-only routine (or a parse failure). */
  schedule: string | null;
  comment: string | null;
  steps: RoutineStep[];
  /** The ROUTINE Schedule row for this file, if one exists. */
  scheduleId: ScheduleId | null;
  scheduleEnabled: boolean | null;
  /** The most recent run of this routine, if any. */
  latestRun: RoutineRunSummary | null;
  /** Non-null when the YAML failed to parse or validate. */
  parseError: string | null;
  /** Semantic warnings for a parsed routine whose referenced folders/connections no longer exist. Empty when all references resolve. */
  referenceWarnings: string[];
}

/**
 * The raw text of a single routine YAML file, as returned by
 * `GET /workbooks/:id/routines/file?path=…`. Unlike `Routine` (the parsed,
 * joined view used for listing), this carries the verbatim file content so the
 * editor can load it into CodeMirror and write it back unchanged.
 */
export interface RoutineFileContent {
  /** The routine file path within the config repo, e.g. "routines/daily-sync.yaml". */
  path: string;
  /** The verbatim YAML text of the file. */
  content: string;
}
