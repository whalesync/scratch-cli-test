/**
 * DEV-10598 — partial-success presentation of a finished publish (pure-logic tests).
 *
 * The load-bearing bit: a connection is stored `failed` whenever the run-job
 * rejected any record, even if it also published some. These helpers derive a
 * DISPLAY-only "partial" state from the per-record counts so the successes
 * aren't hidden behind a flat "Publish failed".
 */

import { describe, expect, it } from 'vitest';
import {
  decidePublishTerminalMode,
  isPartialConnectionSuccess,
  publishedRecordCountFromProgress,
  summarizePublishedRecordCounts,
  type PublishTerminalConnection,
} from '../publish-terminal-status';

describe('publishedRecordCountFromProgress', () => {
  it('sums the record-level executed phases', () => {
    expect(publishedRecordCountFromProgress({ editsExecuted: 2, createsExecuted: 1, deletesExecuted: 3 })).toBe(6);
  });

  it('treats missing phases and missing progress as zero', () => {
    expect(publishedRecordCountFromProgress({ editsExecuted: 2 })).toBe(2);
    expect(publishedRecordCountFromProgress({})).toBe(0);
    expect(publishedRecordCountFromProgress(undefined)).toBe(0);
  });

  it('reflects the DEV-10598 Postgres repro: 2 edits executed, 1 rejected', () => {
    // The run reported editsExecuted:2 (successes) + failedCount:1 — the success
    // count must come from the executed tally, NOT a `successCount` field the
    // server never sends.
    expect(publishedRecordCountFromProgress({ editsExecuted: 2 })).toBe(2);
  });
});

const conn = (
  status: PublishTerminalConnection['status'],
  successCount?: number,
  failedCount?: number,
): PublishTerminalConnection => ({ status, successCount, failedCount });

describe('isPartialConnectionSuccess', () => {
  it('is true for a failed connection that still published some records', () => {
    expect(isPartialConnectionSuccess(conn('failed', 3, 2))).toBe(true);
  });

  it('is false for a failed connection that published nothing', () => {
    expect(isPartialConnectionSuccess(conn('failed', 0, 5))).toBe(false);
    expect(isPartialConnectionSuccess(conn('failed'))).toBe(false);
  });

  it('is false for a non-failed connection', () => {
    expect(isPartialConnectionSuccess(conn('completed', 5, 0))).toBe(false);
    expect(isPartialConnectionSuccess(conn('plan-no-diff'))).toBe(false);
  });
});

describe('decidePublishTerminalMode', () => {
  it('is complete when no connection failed', () => {
    expect(decidePublishTerminalMode([conn('completed', 4, 0), conn('plan-no-diff')])).toBe('complete');
  });

  it('is error when a connection failed and nothing published', () => {
    expect(decidePublishTerminalMode([conn('failed', 0, 3)])).toBe('error');
    expect(decidePublishTerminalMode([conn('failed', 0, 3), conn('failed', 0, 1)])).toBe('error');
  });

  it('is error for a wholesale connection failure that carries no record counts', () => {
    // Plan/transport/crash failures never get run progress, so both counts are 0.
    expect(decidePublishTerminalMode([conn('failed')])).toBe('error');
  });

  it('is error when the only non-failed connection was a no-op completion', () => {
    // A completed connection with successCount 0 published nothing, so a run
    // where it is the only success and another connection failed is a total
    // failure, not a partial success (must not route to the partial screen).
    expect(decidePublishTerminalMode([conn('completed', 0, 0), conn('failed', 0, 2)])).toBe('error');
  });

  it('is partial when the same connection published some records and failed others', () => {
    // The DEV-10598 repro: one connection, one record published, one rejected.
    expect(decidePublishTerminalMode([conn('failed', 1, 1)])).toBe('partial');
  });

  it('is partial when one connection published records and another failed outright', () => {
    // Record-level failure on the other connection.
    expect(decidePublishTerminalMode([conn('completed', 5, 0), conn('failed', 0, 2)])).toBe('partial');
    // Wholesale failure (no counts) on the other connection — still partial
    // because records did publish, and the summary must stay honest.
    expect(decidePublishTerminalMode([conn('completed', 5, 0), conn('failed')])).toBe('partial');
  });
});

describe('summarizePublishedRecordCounts', () => {
  it('aggregates per-record counts across connections', () => {
    const totals = summarizePublishedRecordCounts([conn('completed', 5, 0), conn('failed', 1, 2)]);
    expect(totals).toEqual({ publishedRecordCount: 6, failedRecordCount: 2, totalRecordCount: 8 });
  });

  it('treats missing counts as zero', () => {
    const totals = summarizePublishedRecordCounts([conn('plan-no-diff'), conn('failed', undefined, undefined)]);
    expect(totals).toEqual({ publishedRecordCount: 0, failedRecordCount: 0, totalRecordCount: 0 });
  });
});
