/**
 * DEV-10846: live per-connection progress for an in-flight workspace pull.
 *
 * `scratchmd files download` fans its connections out in parallel and emits one
 * `[pull-progress] {json}` line per event on stderr (stdout carries the single
 * `--json` result object). The main process parses those lines and forwards
 * them here so the pull modal can show real per-connection rows instead of an
 * indeterminate spinner.
 *
 * Event order per pull: exactly one `plan` (the full connection list, before any
 * download starts), then a `started` and a `finished` for each connection.
 * Because connections run concurrently, `started`/`finished` events from
 * different connections interleave freely — consumers must key by `connection`
 * rather than assuming sequential completion.
 */
export type PullConnectionProgressEvent =
  | {
      event: 'plan';
      /** Every connection this pull will download, by workspace directory name. */
      connections: string[];
    }
  | { event: 'started'; connection: string }
  | {
      event: 'finished';
      connection: string;
      /** The CLI's `DownloadResult.status` — `downloaded` / `up_to_date` / `error`. */
      status: string;
      /** Record files this connection wrote to disk. */
      changedRecords: number;
    };

export const PULL_PROGRESS_CHANNEL = 'scratch:pull-progress';

/**
 * Marker the CLI prefixes each progress line with. Mirrors
 * `PULL_PROGRESS_MARKER` in `scratch-git-2/src/cli/commands/files.rs` — keep
 * the two in sync.
 */
export const PULL_PROGRESS_MARKER = '[pull-progress]';

/**
 * True for a line the CLI emitted as pull progress (well-formed or not).
 *
 * Used to keep these lines OUT of captured stderr: the CLI emits them for every
 * `--json files download`, whether or not anyone subscribed, and stderr is what
 * builds a failed pull's error message. Without this filter, a real failure —
 * e.g. the DEV-10641 partial-failure bail, which exits non-zero with nothing on
 * stdout — would be buried under 2N+1 lines of progress JSON and rendered
 * verbatim to the user as `downloadError`.
 *
 * Deliberately looser than `parsePullProgressLine`: a malformed progress line is
 * still progress noise, not diagnostics, so it shouldn't reach an error message
 * either.
 */
export function isPullProgressLine(line: string): boolean {
  return line.trimStart().startsWith(PULL_PROGRESS_MARKER);
}
