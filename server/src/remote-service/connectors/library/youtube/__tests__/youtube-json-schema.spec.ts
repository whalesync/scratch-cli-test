import { Type } from '@sinclair/typebox';
import { X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { BaseJsonTableSpec, dotPath } from '../../../types';
import { getForeignKeyOptions, isForeignKey, isReadonlyField } from '../youtube-json-schema';

// Regression for DEV-10126: YouTube uses dot-notation field paths
// (e.g. `snippet.channelId`). `fieldToPointer` splits on `.` and joins the
// segments with `/properties/`, so each segment must be RFC 6901-escaped
// independently — otherwise a segment containing `/` or `~` walks the wrong
// sub-tree. YouTube API field names don't normally contain those characters,
// but the helper should still be correct.
describe('youtube JSON Pointer escaping (RFC 6901)', () => {
  const fkOptions = { linkedTableId: 'yt_other' };

  function buildSpec(): BaseJsonTableSpec {
    return {
      id: { wsId: 't', remoteId: ['t'] },
      slug: 't',
      name: 't',
      schema: Type.Object({
        // Top-level field whose literal name contains `/`.
        'has/slash': Type.String({ [X_SCRATCH_READONLY]: true }),
        // Nested object where the inner segment contains `/` and `~`.
        snippet: Type.Object({
          'odd/name': Type.String({
            [X_SCRATCH_READONLY]: true,
            [X_SCRATCH_FOREIGN_KEY_OPTIONS]: fkOptions,
          }),
          'tilde~name': Type.String({ [X_SCRATCH_READONLY]: true }),
        }),
      }),
      idPath: dotPath('id'),
    };
  }

  it('isReadonlyField handles top-level field names containing `/`', () => {
    expect(isReadonlyField('has/slash', buildSpec())).toBe(true);
  });

  it('isReadonlyField handles nested dot-notation paths whose last segment contains `/`', () => {
    expect(isReadonlyField('snippet.odd/name', buildSpec())).toBe(true);
  });

  it('isReadonlyField handles nested dot-notation paths whose last segment contains `~`', () => {
    expect(isReadonlyField('snippet.tilde~name', buildSpec())).toBe(true);
  });

  it('isForeignKey handles nested dot-notation paths whose last segment contains `/`', () => {
    expect(isForeignKey('snippet.odd/name', buildSpec())).toBe(true);
  });

  // Regression for DEV-10805: isForeignKey used to compare the boolean result
  // of ValuePointer.Has against `undefined`, so it always returned true.
  it('isForeignKey returns false for a non-foreign-key field', () => {
    expect(isForeignKey('snippet.tilde~name', buildSpec())).toBe(false);
  });

  it('getForeignKeyOptions handles nested dot-notation paths whose last segment contains `/`', () => {
    expect(getForeignKeyOptions('snippet.odd/name', buildSpec())).toEqual(fkOptions);
  });
});
