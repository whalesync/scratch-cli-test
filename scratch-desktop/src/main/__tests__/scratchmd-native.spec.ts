// Slice H.3 of DEV-10144: validate the napi adapter layer in
// `src/main/native/scratchmd-native.ts`. Covers (a) `deriveRecordPaths`'s
// path-conversion contract — the (workspacePath, folderPath, filename)
// triple the IPC handlers pass in must round-trip into the (conn,
// recordRelPath) shape the Rust binding consumes, and (b) the
// `parseNativeErrorCode` helper that extracts the structured error code
// the binding encodes as a message prefix.

import { describe, expect, it } from 'vitest';
// `app` is the only thing the loader imports from electron, but importing
// the module pulls electron in transitively at module-eval time. We only
// exercise pure functions here so a tiny manual mock keeps the test runner
// from booting an Electron context.
import { vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/fake' } }));

import { deriveRecordPaths, parseNativeErrorCode } from '../native/scratchmd-native';

describe('deriveRecordPaths', () => {
  it('splits the workspace-relative folder into connection + record rel path', () => {
    expect(deriveRecordPaths('/workspace', '/workspace/HubSpot/Companies', 'rec_acme.json')).toEqual({
      connectionDirName: 'HubSpot',
      recordRelPath: 'Companies/rec_acme.json',
    });
  });

  it('handles nested folder paths', () => {
    expect(deriveRecordPaths('/workspace', '/workspace/Webflow/Collections/blog_en', 'post_1.json')).toEqual({
      connectionDirName: 'Webflow',
      recordRelPath: 'Collections/blog_en/post_1.json',
    });
  });

  it('throws when folderPath escapes the workspace', () => {
    expect(() => deriveRecordPaths('/workspace', '/other-place/HubSpot/Companies', 'rec.json')).toThrow(
      /not inside workspace/,
    );
  });

  it('throws when folderPath equals workspace (no connection segment)', () => {
    expect(() => deriveRecordPaths('/workspace', '/workspace', 'rec.json')).toThrow(/not inside workspace/);
  });
});

describe('parseNativeErrorCode', () => {
  it('extracts the prefix for a known code', () => {
    const err = new Error('LOCK_BUSY: workspace lock held by pid 12345');
    expect(parseNativeErrorCode(err)).toBe('LOCK_BUSY');
  });

  it('returns undefined for messages without the prefix convention', () => {
    expect(parseNativeErrorCode(new Error('something went sideways'))).toBeUndefined();
  });

  it('returns undefined for unknown code prefixes', () => {
    // Defends against future drift — if the Rust side adds a new code we'll
    // see undefined here instead of silently routing through the catch-all.
    expect(parseNativeErrorCode(new Error('SOMETHING_NEW: details'))).toBeUndefined();
  });

  it('returns undefined for non-Error values', () => {
    expect(parseNativeErrorCode('LOCK_BUSY: not an Error')).toBeUndefined();
    expect(parseNativeErrorCode(null)).toBeUndefined();
    expect(parseNativeErrorCode(undefined)).toBeUndefined();
  });
});
