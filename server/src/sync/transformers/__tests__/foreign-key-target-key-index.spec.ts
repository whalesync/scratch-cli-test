import {
  buildForeignKeyTargetKeyIndex,
  resolveForeignKeyValueAgainstTargetKeyIndex,
  type TargetRecordForKeyIndex,
} from '../foreign-key-target-key-index';

/**
 * The non-id foreign-key target index (DEV-11085) — the unit that lets a reference name its target
 * by a field other than the target's remote id (Framer's references carry the target's slug).
 */
describe('buildForeignKeyTargetKeyIndex', () => {
  const FRAMER_TAGS: TargetRecordForKeyIndex[] = [
    { id: 'item_aaa', fields: { id: 'item_aaa', slug: 'engineering', fieldData: {} } },
    { id: 'item_bbb', fields: { id: 'item_bbb', slug: 'design', fieldData: {} } },
  ];

  function resolve(records: TargetRecordForKeyIndex[], keyPath: string, value: string) {
    return resolveForeignKeyValueAgainstTargetKeyIndex(buildForeignKeyTargetKeyIndex(records, keyPath), value);
  }

  it('resolves a key value to the remote id of the target record that claims it', () => {
    expect(resolve(FRAMER_TAGS, 'slug', 'engineering')).toEqual({
      kind: 'resolved',
      targetSourceRemoteId: 'item_aaa',
    });
  });

  it('reports no match for a value no target record claims', () => {
    expect(resolve(FRAMER_TAGS, 'slug', 'marketing')).toEqual({ kind: 'no_match' });
  });

  it('does NOT fall back to matching the remote id when a key path is declared', () => {
    // `item_aaa` is a real remote id, but the declared key is `slug` — matching it would make
    // resolution depend on which of two namespaces a value happens to land in.
    expect(resolve(FRAMER_TAGS, 'slug', 'item_aaa')).toEqual({ kind: 'no_match' });
  });

  it('matches exactly — no case folding or trimming', () => {
    expect(resolve(FRAMER_TAGS, 'slug', 'Engineering')).toEqual({ kind: 'no_match' });
    expect(resolve(FRAMER_TAGS, 'slug', ' engineering')).toEqual({ kind: 'no_match' });
  });

  it('reports a value claimed by two records as ambiguous rather than picking one', () => {
    const collidingTags: TargetRecordForKeyIndex[] = [
      { id: 'item_aaa', fields: { slug: 'engineering' } },
      { id: 'item_bbb', fields: { slug: 'engineering' } },
    ];
    expect(resolve(collidingTags, 'slug', 'engineering')).toEqual({ kind: 'ambiguous', matchCount: 2 });
  });

  it('counts every claimant of an ambiguous value', () => {
    const collidingTags: TargetRecordForKeyIndex[] = [
      { id: 'a', fields: { slug: 'dup' } },
      { id: 'b', fields: { slug: 'dup' } },
      { id: 'c', fields: { slug: 'dup' } },
    ];
    expect(resolve(collidingTags, 'slug', 'dup')).toEqual({ kind: 'ambiguous', matchCount: 3 });
  });

  it('keeps unambiguous siblings resolvable when another value collides', () => {
    const mixedTags: TargetRecordForKeyIndex[] = [
      { id: 'a', fields: { slug: 'dup' } },
      { id: 'b', fields: { slug: 'dup' } },
      { id: 'c', fields: { slug: 'unique' } },
    ];
    expect(resolve(mixedTags, 'slug', 'unique')).toEqual({ kind: 'resolved', targetSourceRemoteId: 'c' });
  });

  it('reads a nested key path', () => {
    const records: TargetRecordForKeyIndex[] = [{ id: 'r1', fields: { fieldData: { fSlug: { value: 'nested' } } } }];
    expect(resolve(records, 'fieldData.fSlug.value', 'nested')).toEqual({
      kind: 'resolved',
      targetSourceRemoteId: 'r1',
    });
  });

  it('matches a numeric key stored as a number against its string form', () => {
    // A Postgres `REFERENCES other(legacy_code)` reads the referencing value as a number.
    const records: TargetRecordForKeyIndex[] = [{ id: 'r1', fields: { legacy_code: 4071 } }];
    expect(resolve(records, 'legacy_code', '4071')).toEqual({ kind: 'resolved', targetSourceRemoteId: 'r1' });
  });

  it('leaves a record whose key is missing or null out of the index entirely', () => {
    const records: TargetRecordForKeyIndex[] = [
      { id: 'has_none', fields: { title: 'no slug here' } },
      { id: 'has_null', fields: { slug: null } },
      { id: 'has_one', fields: { slug: 'real' } },
    ];
    const index = buildForeignKeyTargetKeyIndex(records, 'slug');
    expect(index.targetSourceRemoteIdByKeyValue.size).toBe(1);
    expect(resolveForeignKeyValueAgainstTargetKeyIndex(index, 'real')).toEqual({
      kind: 'resolved',
      targetSourceRemoteId: 'has_one',
    });
    // Two records share "no key", but that is not a collision — neither can be named by it.
    expect(index.claimCountByAmbiguousKeyValue.size).toBe(0);
  });

  it('ignores a record whose key value is a structure rather than a scalar', () => {
    const records: TargetRecordForKeyIndex[] = [{ id: 'r1', fields: { slug: { nested: 'x' } } }];
    expect(buildForeignKeyTargetKeyIndex(records, 'slug').targetSourceRemoteIdByKeyValue.size).toBe(0);
  });

  it('handles an empty folder', () => {
    expect(resolve([], 'slug', 'anything')).toEqual({ kind: 'no_match' });
  });
});
