import * as fs from 'fs';
import * as path from 'path';
import { applyJsonPatch, isJsonPatchDialect } from '../json-patch';

// The shared parity corpus lives in the Rust crate and is exercised by both
// engines. This is the contract that keeps the TS applier semantically
// equivalent to `scratch-git-2/src/shared/json_patch.rs`.
const CORPUS_DIR = path.resolve(__dirname, '../../../../scratch-git-2/src/shared/testdata/json_patch');

interface ApplyFixture {
  description: string;
  base: unknown;
  patch: unknown[];
  expected?: unknown;
  error?: boolean;
}

interface DiffFixture {
  description: string;
  old: unknown;
  new: unknown;
  patch: unknown[];
}

function loadFixtures<T>(subdir: string): Array<{ name: string; fixture: T }> {
  const dir = path.join(CORPUS_DIR, subdir);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  expect(files.length).toBeGreaterThan(0);
  return files.map((name) => ({ name, fixture: JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as T }));
}

describe('applyJsonPatch — shared parity corpus (incl. RFC 6902 Appendix A)', () => {
  for (const { name, fixture } of loadFixtures<ApplyFixture>('apply')) {
    it(`apply ${name}: ${fixture.description}`, () => {
      if (fixture.error) {
        expect(() => applyJsonPatch(fixture.base, fixture.patch)).toThrow();
      } else {
        expect(applyJsonPatch(fixture.base, fixture.patch)).toEqual(fixture.expected);
      }
    });
  }

  // The differ is Rust-only; the TS engine verifies its applier reconstructs
  // `new` from the differ's emitted patch (the second half of the round trip).
  for (const { name, fixture } of loadFixtures<DiffFixture>('diff')) {
    it(`diff-apply ${name}: ${fixture.description}`, () => {
      expect(applyJsonPatch(fixture.old, fixture.patch)).toEqual(fixture.new);
    });
  }
});

describe('applyJsonPatch — direct behavior', () => {
  it('treats null as an ordinary value (add) distinct from delete (remove)', () => {
    expect(applyJsonPatch({ a: 1 }, [{ op: 'add', path: '/a', value: null }])).toEqual({ a: null });
    expect(applyJsonPatch({ a: null, b: 2 }, [{ op: 'remove', path: '/a' }])).toEqual({ b: 2 });
  });

  it('does not mutate the input target', () => {
    const target = { a: 1 };
    applyJsonPatch(target, [{ op: 'add', path: '/b', value: 2 }]);
    expect(target).toEqual({ a: 1 });
  });

  it('addresses keys containing dots and slashes via JSON Pointer', () => {
    expect(applyJsonPatch({}, [{ op: 'add', path: '/a.b', value: 1 }])).toEqual({ 'a.b': 1 });
    expect(applyJsonPatch({}, [{ op: 'add', path: '/c~1d', value: 2 }])).toEqual({ 'c/d': 2 });
  });

  it('fails the whole patch (throws) when any op fails', () => {
    expect(() =>
      applyJsonPatch({ a: 1 }, [
        { op: 'add', path: '/b', value: 2 },
        { op: 'remove', path: '/missing' },
      ]),
    ).toThrow();
  });

  it('rejects an unknown op', () => {
    expect(() => applyJsonPatch({ a: 1 }, [{ op: 'frobnicate', path: '/a' }])).toThrow(/unknown RFC 6902 op/);
  });
});

describe('isJsonPatchDialect', () => {
  it('distinguishes a 6902 op array from a 7396 merge-patch object', () => {
    expect(isJsonPatchDialect([{ op: 'add', path: '/a', value: 1 }])).toBe(true);
    expect(isJsonPatchDialect([])).toBe(true);
    expect(isJsonPatchDialect({ a: 1 })).toBe(false);
    expect(isJsonPatchDialect({})).toBe(false);
    expect(isJsonPatchDialect(null)).toBe(false);
  });
});
