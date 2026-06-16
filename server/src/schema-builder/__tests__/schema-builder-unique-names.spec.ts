import { allocateUniqueName, normalizeNameForUniqueness } from '../schema-builder-unique-names';

describe('normalizeNameForUniqueness', () => {
  it('trims and lowercases (matching the zod duplicate rule)', () => {
    expect(normalizeNameForUniqueness('  Name  ')).toBe('name');
    expect(normalizeNameForUniqueness('NAME')).toBe('name');
  });
});

describe('allocateUniqueName', () => {
  it('returns the requested name unchanged when free, and records it as taken', () => {
    const taken = new Set<string>();
    expect(allocateUniqueName('Title', taken)).toBe('Title');
    expect(taken.has('title')).toBe(true);
  });

  it('appends " 2", " 3", … to successive duplicates (original keeps its bare name)', () => {
    const taken = new Set<string>();
    expect(allocateUniqueName('Tags', taken)).toBe('Tags');
    expect(allocateUniqueName('Tags', taken)).toBe('Tags 2');
    expect(allocateUniqueName('Tags', taken)).toBe('Tags 3');
  });

  it('collides case-insensitively', () => {
    const taken = new Set<string>();
    expect(allocateUniqueName('Name', taken)).toBe('Name');
    // 'name' normalizes to the same key as 'Name', so it is suffixed.
    expect(allocateUniqueName('name', taken)).toBe('name 2');
  });

  it('skips a suffix that is itself already taken (cascading collision)', () => {
    const taken = new Set<string>(['base', 'base 2']);
    expect(allocateUniqueName('base', taken)).toBe('base 3');
  });

  it('honors a pre-seeded set (e.g. existing destination names)', () => {
    const taken = new Set<string>(['name', 'bio']);
    // Collides with the seed → suffixed.
    expect(allocateUniqueName('Name', taken)).toBe('Name 2');
    // Free against the seed → unchanged, then recorded.
    expect(allocateUniqueName('Age', taken)).toBe('Age');
    expect(allocateUniqueName('Age', taken)).toBe('Age 2');
  });
});
