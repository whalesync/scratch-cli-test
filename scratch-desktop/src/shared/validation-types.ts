/**
 * Validation types shared across all processes in the desktop app.
 *
 * These types mirror the contract defined by the `scratchmd` CLI's
 * `validation get-file-problems` and `validation get-folder-problems` commands,
 * which read from the `validation_results` SQLite table.
 *
 * Source of truth (Rust): scratch-git-2/src/shared/validators/mod.rs
 * Docs: scratch-git-2/docs/VALIDATION.md
 */

/**
 * Raw validation result row as returned by the scratchmd CLI.
 * Field names are snake_case to match the SQLite column names.
 */
export type ValidationResultRow = {
  /** Filename of the record (e.g. `post-1.json`). Present in folder-level results; absent in single-record results. */
  file_name?: string;
  /** Dot-notation field path within the record (e.g. `title`, `author.name`). */
  field_path: string;
  /** The validator kind string (e.g. `length`, `enforce_schema`, `python:validators/check.py`). */
  validator_kind: string;
  /** Severity level. `error` = hard constraint violated; `warning` = soft constraint. */
  level: 'error' | 'warning';
  /** Short human-readable description of the violation. Null if not provided. */
  message: string | null;
  /** Optional longer explanation shown as a secondary line in the UI. Null if not provided. */
  description: string | null;
  /** Whether the violation can be auto-fixed (reserved for future use — always false today). */
  fixable: boolean;
};

/**
 * Per-folder validation issue counts returned by `validation get-stats`.
 */
export type ValidationStat = {
  connection: string;
  folder_path: string;
  errors: number;
  warnings: number;
  /** Number of distinct records (files) that have at least one violation. */
  records: number;
};

/**
 * Scope for a "rerun validation" action — re-run all validators against the current index
 * and refresh stored results, non-destructively. One of three scopes:
 * a single data folder, a whole connector, or the entire workbook.
 */
export type RerunValidationScope =
  | { kind: 'folder'; folderPath: string }
  | { kind: 'connection'; connection: string }
  | { kind: 'workspace' };

/**
 * Aggregate result of `scratchmd validation rerun` (mirrors the Rust `RerunSummary`).
 * snake_case to match the CLI's JSON output.
 */
export type RerunValidationSummary = {
  scope: 'folder' | 'connection' | 'workspace';
  folders_revalidated: number;
  records_validated: number;
  errors: number;
  warnings: number;
  skipped_folders: number;
};

/**
 * Validation entry mapped to camelCase for use in UI components.
 * Produced by mapping a `ValidationResultRow` after the CLI call returns.
 */
export type ValidationEntry = {
  level: 'error' | 'warning';
  message: string | null;
  description: string | null;
  fixable: boolean;
  /** The validator kind string (e.g. `length`, `enforce_schema`). */
  validatorKind: string;
  /** Field path within the record. Optional when showing record-level aggregates. */
  fieldPath?: string;
};

// ---------------------------------------------------------------------------
// Validator configuration types (mirrors the on-disk validation.json format)
// ---------------------------------------------------------------------------

/**
 * One entry in a table's `validation.json` file.
 *
 * Mirrors the Rust `ValidatorEntry` struct in
 * `scratch-git-2/src/shared/validators/mod.rs`.
 */
export type ValidatorConfigEntry = {
  /** Validator kind string (e.g. `required`, `length`, `python:validators/check.py`). */
  validator: string;
  /** Single field path targeted by this validator. Mutually exclusive with `fields`. */
  field?: string;
  /** Multiple field paths (for multi-field validators). Mutually exclusive with `field`. */
  fields?: string[];
  /** Arguments passed to the validator function. */
  params?: Record<string, unknown>;
  /** Optional execution order (ascending). */
  order?: number;
  /** Free-text annotation for humans. */
  note?: string;
};

/**
 * The parsed contents of one folder's `validation.json`, enriched with its
 * location within the workspace.
 */
export type ValidatorConfig = {
  /** Connection directory name (e.g. `my-airtable`). */
  connection: string;
  /** Subfolder path relative to the connection directory (e.g. `posts` or empty string for root). */
  folderPath: string;
  /** Workspace-relative path to the validation.json file (e.g. `.scratch/connections/scratch/my-airtable/posts/validation.json`). */
  configFilePath: string;
  /** The validator entries defined in this file. */
  entries: ValidatorConfigEntry[];
};

/**
 * Describes a built-in validator available in the system.
 */
export type BuiltinValidatorInfo = {
  /** Validator kind name (e.g. `required`). */
  name: string;
  /** Human-readable description of what this validator checks. */
  description: string;
  /** Whether this validator targets a single field (`field`), multiple fields (`fields`), or the whole record (`record`). */
  scope: 'field' | 'fields' | 'record';
  /** JSON-schema-like description of expected `params`. Null when no params are needed. */
  paramSchema: Record<string, unknown> | null;
};
