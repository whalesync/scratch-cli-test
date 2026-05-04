/**
 * Validation types shared across all processes in the desktop app.
 *
 * These types mirror the contract defined by the `scratchmd` CLI's
 * `get-validation-results` and `get-folder-validation-results` commands,
 * which read from the `validation_results_v1` SQLite table.
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
