import { describe, expect, it } from 'vitest';
import { resolveCellFailedError } from '../failed-fields';

/**
 * Per-cell "failed to publish" resolution (publish redesign, DEV-10048).
 */
describe('resolveCellFailedError', () => {
  it('returns undefined when the record has no failed-publish detail', () => {
    expect(
      resolveCellFailedError({
        failedFields: undefined,
        recordError: undefined,
        effectivePath: 'Organization',
        fieldName: 'Organization',
        hasDiff: true,
      }),
    ).toBeUndefined();
  });

  it('prefers a per-field message keyed by the effective (subfield) path', () => {
    expect(
      resolveCellFailedError({
        failedFields: { 'properties.city': 'bad city', properties: 'should not win' },
        recordError: 'record-level',
        effectivePath: 'properties.city',
        fieldName: 'properties',
        hasDiff: true,
      }),
    ).toBe('bad city');
  });

  it('falls back to the root field key when there is no effective-path message', () => {
    expect(
      resolveCellFailedError({
        failedFields: { Organization: 'Organization cannot be null' },
        recordError: 'record-level',
        effectivePath: 'Organization.id',
        fieldName: 'Organization',
        hasDiff: true,
      }),
    ).toBe('Organization cannot be null');
  });

  it('falls back to the record-level error only on a cell that shows a diff', () => {
    const args = {
      failedFields: {} as Record<string, string>,
      recordError: 'Organization cannot be null',
      effectivePath: 'Name',
      fieldName: 'Name',
    };
    // The field the user is re-editing (has a diff) gets the record-level message...
    expect(resolveCellFailedError({ ...args, hasDiff: true })).toBe('Organization cannot be null');
    // ...but an untouched cell on the same row does not light up.
    expect(resolveCellFailedError({ ...args, hasDiff: false })).toBeUndefined();
  });

  it('a per-field message wins even when the cell shows no diff', () => {
    expect(
      resolveCellFailedError({
        failedFields: { Organization: 'Organization cannot be null' },
        recordError: undefined,
        effectivePath: 'Organization',
        fieldName: 'Organization',
        hasDiff: false,
      }),
    ).toBe('Organization cannot be null');
  });
});
