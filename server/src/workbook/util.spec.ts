import {
  deduplicateFileName,
  isUsableFileNameSlug,
  normalizeFileName,
  resolveBaseFileName,
  sanitizeRecordIdForFileName,
} from './util';

describe('isUsableFileNameSlug', () => {
  it('accepts slugs starting with a letter', () => {
    expect(isUsableFileNameSlug('hi')).toBe(true);
    expect(isUsableFileNameSlug('my-product')).toBe(true);
  });

  it('accepts slugs starting with a digit', () => {
    expect(isUsableFileNameSlug('123abc')).toBe(true);
  });

  it('rejects empty strings (all-stripped slugs)', () => {
    expect(isUsableFileNameSlug('')).toBe(false);
  });

  it('rejects pure-hyphen slugs (CJK-then-ASCII source)', () => {
    expect(isUsableFileNameSlug('-')).toBe(false);
    expect(isUsableFileNameSlug('--')).toBe(false);
  });

  it('rejects leading-hyphen slugs (would produce flag-like filenames)', () => {
    expect(isUsableFileNameSlug('-alex')).toBe(false);
  });

  it('rejects leading-dot slugs (would produce hidden filenames)', () => {
    expect(isUsableFileNameSlug('.foo')).toBe(false);
  });
});

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

  it('should return ID when slug is non-ASCII (would normalize to empty)', () => {
    // Stripe customer name "鄭菲菲" — normalizes to "" because all chars are
    // outside [a-z0-9 -]. Without the usable-slug check, this produced a
    // bare ".json" filename.
    expect(resolveBaseFileName({ slugValue: '鄭菲菲', idValue: 'cus_UIwiCVpf1KLsLA' })).toBe('cus_UIwiCVpf1KLsLA');
  });

  it('should return ID when slug normalizes to a pure-hyphen sequence', () => {
    // Armenian "ԴեմԱռԴեմ Թիմ" normalizes to "-" (space → hyphen + all chars
    // stripped). Without the check, this produced "-.json".
    expect(resolveBaseFileName({ slugValue: 'ԴեմԱռԴեմ Թիմ', idValue: 'cus_UFxltZEOb1MOPj' })).toBe(
      'cus_UFxltZEOb1MOPj',
    );
  });

  it('should fall through to title when slug normalization is unusable', () => {
    expect(resolveBaseFileName({ slugValue: '鄭菲菲', titleValue: 'Fallback Title', idValue: 'abc' })).toBe(
      'fallback-title',
    );
  });

  it('should return ID when slug normalizes to a leading-hyphen result', () => {
    // Korean "안현수 (Alex)" normalizes to "-alex" (the leading Korean strips,
    // the space becomes a hyphen). POSIX-valid but flag-like.
    expect(resolveBaseFileName({ slugValue: '안현수 (Alex)', idValue: 'cus_Nqm5lajp4rDwl6' })).toBe(
      'cus_Nqm5lajp4rDwl6',
    );
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

describe('sanitizeRecordIdForFileName', () => {
  it('strips the path separators out of a Shopify GID so it stays a single filename', () => {
    // The DEV-11015 bug: this GID used verbatim staged as `gid:/shopify/ProductVariant/…`.
    const result = sanitizeRecordIdForFileName('gid://shopify/ProductVariant/51423653331240');
    expect(result).not.toContain('/');
    expect(result).toBe('gid-shopify-ProductVariant-51423653331240');
  });

  it('keeps distinct GIDs distinct (preserves the unique numeric id)', () => {
    const a = sanitizeRecordIdForFileName('gid://shopify/Product/10358826008872');
    const b = sanitizeRecordIdForFileName('gid://shopify/Product/10358826008873');
    expect(a).not.toBe(b);
  });

  it('preserves case and digits (unlike normalizeFileName) so ids do not collide', () => {
    expect(sanitizeRecordIdForFileName('recABC123')).toBe('recABC123');
    expect(sanitizeRecordIdForFileName('recAbc123')).not.toBe(sanitizeRecordIdForFileName('recABC123'));
  });

  it('produces a usable, visible slug (never leading . or -)', () => {
    expect(isUsableFileNameSlug(sanitizeRecordIdForFileName('gid://shopify/Media/1'))).toBe(true);
    expect(sanitizeRecordIdForFileName('/leading/slash')).not.toMatch(/^[-.]/);
    expect(sanitizeRecordIdForFileName('...dots')).toBe('dots');
  });

  it('falls back to "record" for an empty or all-unsafe id', () => {
    expect(sanitizeRecordIdForFileName('')).toBe('record');
    expect(sanitizeRecordIdForFileName('///')).toBe('record');
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
