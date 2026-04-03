import { deduplicateFileName, normalizeFileName, resolveBaseFileName } from './util';

describe('resolveBaseFileName', () => {
  it('should return normalized slug when slug is present', () => {
    expect(resolveBaseFileName({ slugValue: 'My Product', idValue: 'abc123' })).toBe('my-product');
  });

  it('should return normalized title when slug is missing but title is present', () => {
    expect(resolveBaseFileName({ titleValue: 'Blog Post Title', idValue: 'abc123' })).toBe('blog-post-title');
  });

  it('should return ID when both slug and title are missing', () => {
    expect(resolveBaseFileName({ idValue: 'abc123' })).toBe('abc123');
  });

  it('should return ID when slug is empty string', () => {
    expect(resolveBaseFileName({ slugValue: '', idValue: 'abc123' })).toBe('abc123');
  });

  it('should return ID when slug is whitespace only', () => {
    expect(resolveBaseFileName({ slugValue: '   ', idValue: 'abc123' })).toBe('abc123');
  });

  it('should fall through to title when slug is null', () => {
    expect(resolveBaseFileName({ slugValue: null, titleValue: 'My Title', idValue: 'abc123' })).toBe('my-title');
  });

  it('should normalize accented characters in slug', () => {
    expect(resolveBaseFileName({ slugValue: 'café-résumé', idValue: 'abc123' })).toBe('cafe-resume');
  });

  it('should normalize special characters in slug', () => {
    expect(resolveBaseFileName({ slugValue: 'hello_world!@#', idValue: 'abc123' })).toBe('helloworld');
  });
});

describe('normalizeFileName', () => {
  it('should not truncate names under 80 characters', () => {
    expect(normalizeFileName('short-name')).toBe('short-name');
  });

  it('should truncate names longer than 80 characters', () => {
    const longName = 'a'.repeat(100);
    expect(normalizeFileName(longName)).toHaveLength(80);
  });

  it('should remove trailing hyphens after truncation', () => {
    // Create a string where char 80 lands in the middle of a hyphen sequence
    const name = 'a'.repeat(79) + '- more words here';
    const result = normalizeFileName(name);
    expect(result).not.toMatch(/-$/);
    expect(result.length).toBeLessThanOrEqual(80);
  });

  it('should handle all-special-character input resulting in empty string', () => {
    expect(normalizeFileName('!!!@@@###')).toBe('');
  });
});

describe('deduplicateFileName', () => {
  it('should return base name when no collision', () => {
    const existing = new Set<string>();
    expect(deduplicateFileName('my-post', '.json', existing, 'rec001')).toBe('my-post.json');
  });

  it('should append record ID when collision occurs', () => {
    const existing = new Set<string>(['my-post.json']);
    expect(deduplicateFileName('my-post', '.json', existing, 'rec001')).toBe('my-post-rec001.json');
  });

  it('should add the final name to the existing set', () => {
    const existing = new Set<string>();
    deduplicateFileName('my-post', '.json', existing, 'rec001');
    expect(existing.has('my-post.json')).toBe(true);
  });

  it('should add the deduped name to the existing set on collision', () => {
    const existing = new Set<string>(['my-post.json']);
    deduplicateFileName('my-post', '.json', existing, 'rec001');
    expect(existing.has('my-post-rec001.json')).toBe(true);
  });

  it('should handle .md extension', () => {
    const existing = new Set<string>(['my-post.md']);
    expect(deduplicateFileName('my-post', '.md', existing, 'rec001')).toBe('my-post-rec001.md');
  });
});
