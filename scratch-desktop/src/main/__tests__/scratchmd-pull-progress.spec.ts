// DEV-10846: locks down the stderr wire-shape the desktop reads for live
// per-connection pull progress.
//
// `scratchmd --json files download` fans its connections out in parallel and
// emits one `[pull-progress] {json}` line per event on stderr — stdout carries
// the single `--json` result object, so progress can't go there. The stderr
// stream also carries ordinary warn-and-skip notices (e.g. DEV-10421's "failed
// to set up connection"), so the parser has to pick progress lines out of that
// noise and ignore everything else.
//
// Producer side: `PULL_PROGRESS_MARKER` / `emit_pull_progress` in
// `scratch-git-2/src/cli/commands/files.rs`.

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/fake' } }));

import { isPullProgressLine } from '../../shared/pull-progress-events';
import { parsePullProgressLine } from '../scratchmd';

describe('parsePullProgressLine', () => {
  it('parses the plan event that announces every connection up front', () => {
    const parsed = parsePullProgressLine(
      '[pull-progress] {"event":"plan","connections":["Stripe","HubSpot","Intercom"]}',
    );
    if (parsed?.event !== 'plan') throw new Error('expected plan');
    expect(parsed.connections).toEqual(['Stripe', 'HubSpot', 'Intercom']);
  });

  it('parses a started event', () => {
    const parsed = parsePullProgressLine('[pull-progress] {"event":"started","connection":"Stripe"}');
    if (parsed?.event !== 'started') throw new Error('expected started');
    expect(parsed.connection).toBe('Stripe');
  });

  it('parses a finished event with its status and record count', () => {
    const parsed = parsePullProgressLine(
      '[pull-progress] {"event":"finished","connection":"Stripe","status":"downloaded","changedRecords":59}',
    );
    if (parsed?.event !== 'finished') throw new Error('expected finished');
    expect(parsed.connection).toBe('Stripe');
    expect(parsed.status).toBe('downloaded');
    expect(parsed.changedRecords).toBe(59);
  });

  it('parses the error branch a failed connection emits before its siblings carry on', () => {
    const parsed = parsePullProgressLine(
      '[pull-progress] {"event":"finished","connection":"Webflow","status":"error","changedRecords":0}',
    );
    if (parsed?.event !== 'finished') throw new Error('expected finished');
    expect(parsed.status).toBe('error');
    expect(parsed.changedRecords).toBe(0);
  });

  it('tolerates surrounding whitespace from the line splitter', () => {
    expect(parsePullProgressLine('  [pull-progress] {"event":"started","connection":"Notion"}  ')).not.toBeNull();
  });

  it('ignores ordinary stderr notices that share the stream', () => {
    expect(parsePullProgressLine('  Warning: failed to set up connection Airtable: repo not ready')).toBeNull();
    expect(parsePullProgressLine('  Note: could not fetch folder metadata for reconcile: timeout')).toBeNull();
    expect(parsePullProgressLine('')).toBeNull();
  });

  it('ignores a malformed progress line rather than failing an otherwise-succeeding pull', () => {
    expect(parsePullProgressLine('[pull-progress] {not json')).toBeNull();
    expect(parsePullProgressLine('[pull-progress] null')).toBeNull();
    expect(parsePullProgressLine('[pull-progress] "a string"')).toBeNull();
  });

  it('ignores a well-formed JSON object that is not a known event', () => {
    expect(parsePullProgressLine('[pull-progress] {"event":"who_knows","connection":"Stripe"}')).toBeNull();
    // `plan` without a connections array, and `started` without a connection name.
    expect(parsePullProgressLine('[pull-progress] {"event":"plan"}')).toBeNull();
    expect(parsePullProgressLine('[pull-progress] {"event":"started"}')).toBeNull();
    expect(parsePullProgressLine('[pull-progress] {"event":"started","connection":42}')).toBeNull();
  });
});

// The CLI emits progress for EVERY `--json files download`, whether or not a
// caller subscribed, so these lines land in captured stderr unless filtered.
// stderr is what builds a failed pull's error message — most visibly the
// DEV-10641 partial-failure bail, which exits non-zero with nothing on stdout
// and is rendered verbatim to the user as `downloadError`.
describe('isPullProgressLine (keeps progress out of diagnostic stderr)', () => {
  it('matches every progress event the CLI emits', () => {
    expect(isPullProgressLine('[pull-progress] {"event":"plan","connections":["Stripe"]}')).toBe(true);
    expect(isPullProgressLine('[pull-progress] {"event":"started","connection":"Stripe"}')).toBe(true);
    expect(
      isPullProgressLine(
        '[pull-progress] {"event":"finished","connection":"Stripe","status":"downloaded","changedRecords":1}',
      ),
    ).toBe(true);
  });

  it('matches a malformed progress line too — it is noise, not diagnostics', () => {
    // Looser than `parsePullProgressLine` on purpose: that returns null here,
    // but the line still must not surface inside a user-facing error message.
    expect(parsePullProgressLine('[pull-progress] {truncated')).toBeNull();
    expect(isPullProgressLine('[pull-progress] {truncated')).toBe(true);
  });

  it('keeps the real diagnostics that share the stream', () => {
    expect(
      isPullProgressLine('1 of 3 connection(s) failed to download (Stripe); the others were pulled successfully.'),
    ).toBe(false);
    expect(isPullProgressLine('  Warning: failed to download Stripe: git fetch failed')).toBe(false);
    expect(isPullProgressLine('  Warning: failed to set up connection Airtable: repo not ready')).toBe(false);
    expect(isPullProgressLine('')).toBe(false);
  });

  it('filtering a realistic failed-pull stderr leaves only the actionable message', () => {
    // What a 3-connection pull with one failure actually writes to stderr.
    const stderr = [
      '[pull-progress] {"event":"plan","connections":["Stripe","HubSpot","Webflow"]}',
      '[pull-progress] {"event":"started","connection":"Stripe"}',
      '[pull-progress] {"event":"started","connection":"HubSpot"}',
      '[pull-progress] {"event":"started","connection":"Webflow"}',
      '[pull-progress] {"event":"finished","connection":"HubSpot","status":"up_to_date","changedRecords":0}',
      '[pull-progress] {"event":"finished","connection":"Webflow","status":"error","changedRecords":0}',
      '  Warning: failed to download Webflow: git fetch failed',
      '[pull-progress] {"event":"finished","connection":"Stripe","status":"downloaded","changedRecords":59}',
      '1 of 3 connection(s) failed to download (Webflow); the others were pulled successfully. Re-run the download to retry.',
    ];

    const diagnostics = stderr.filter((line) => !isPullProgressLine(line));

    expect(diagnostics).toEqual([
      '  Warning: failed to download Webflow: git fetch failed',
      '1 of 3 connection(s) failed to download (Webflow); the others were pulled successfully. Re-run the download to retry.',
    ]);
    // The message the user sees starts with the real failure, not JSON.
    expect(diagnostics.join('\n').trim().startsWith('Warning: failed to download Webflow')).toBe(true);
  });

  it('leaves the DEV-10421 connection-setup marker intact for the tracker to scan', () => {
    // `usePullTracker` does a substring scan on the returned stderr to detect
    // this warn-and-skip; the filter must not swallow it.
    const stderr = [
      '[pull-progress] {"event":"plan","connections":["Airtable"]}',
      '  Warning: failed to set up connection Airtable: repo not ready',
    ];
    const filtered = stderr.filter((line) => !isPullProgressLine(line)).join('\n');
    expect(filtered.includes('failed to set up connection')).toBe(true);
  });
});
