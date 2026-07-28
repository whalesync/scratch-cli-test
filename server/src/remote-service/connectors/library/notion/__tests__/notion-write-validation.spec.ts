import {
  NOTION_RICH_TEXT_MAX_CONTENT_LENGTH,
  chunkStringToNotionRichTextLimit,
  extractNotionRejectedPropertyName,
  findUnwritableNotionDateBoundary,
  isNotionWritableDateBoundary,
  splitRichTextSpansToNotionLimit,
} from '../notion-write-validation';

const CAP = NOTION_RICH_TEXT_MAX_CONTENT_LENGTH;

describe('chunkStringToNotionRichTextLimit', () => {
  it('returns the string unchanged when within the cap', () => {
    expect(chunkStringToNotionRichTextLimit('hello')).toEqual(['hello']);
    const exact = 'x'.repeat(CAP);
    expect(chunkStringToNotionRichTextLimit(exact)).toEqual([exact]);
  });

  it('splits an over-cap string into consecutive chunks that rejoin losslessly', () => {
    const content = 'a'.repeat(CAP) + 'b'.repeat(602); // 2602, the reported failure size
    const chunks = chunkStringToNotionRichTextLimit(content);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(CAP);
    expect(chunks[1]).toHaveLength(602);
    expect(chunks.every((chunk) => chunk.length <= CAP)).toBe(true);
    expect(chunks.join('')).toBe(content);
  });

  it('produces enough chunks for very long content, each within the cap', () => {
    const content = 'z'.repeat(CAP * 3 + 1);
    const chunks = chunkStringToNotionRichTextLimit(content);
    expect(chunks).toHaveLength(4);
    expect(chunks.every((chunk) => chunk.length <= CAP)).toBe(true);
    expect(chunks.join('')).toBe(content);
  });

  it('never splits a surrogate pair across a boundary', () => {
    // Fill to one code unit short of the cap, then place an emoji (a surrogate
    // pair) straddling the boundary. The pair must stay whole in one chunk.
    const emoji = '😀'; // U+1F600, a 2-code-unit surrogate pair
    const content = 'a'.repeat(CAP - 1) + emoji + 'b'.repeat(10);
    const chunks = chunkStringToNotionRichTextLimit(content);
    expect(chunks.join('')).toBe(content);
    // No chunk ends on a lone high surrogate.
    for (const chunk of chunks) {
      const last = chunk.charCodeAt(chunk.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });
});

describe('splitRichTextSpansToNotionLimit', () => {
  const makeTextSpan = (content: string) => ({
    type: 'text',
    text: { content },
    plain_text: content,
    annotations: { bold: true },
  });

  it('returns the original array reference when nothing exceeds the cap', () => {
    const spans = [makeTextSpan('short'), makeTextSpan('also short')];
    expect(splitRichTextSpansToNotionLimit(spans)).toBe(spans);
  });

  it('splits an oversized span, preserving annotations and syncing plain_text', () => {
    const content = 'a'.repeat(CAP) + 'b'.repeat(500);
    const result = splitRichTextSpansToNotionLimit([makeTextSpan(content)]);

    expect(result).toHaveLength(2);
    expect(result).toEqual([
      { type: 'text', text: { content: 'a'.repeat(CAP) }, plain_text: 'a'.repeat(CAP), annotations: { bold: true } },
      { type: 'text', text: { content: 'b'.repeat(500) }, plain_text: 'b'.repeat(500), annotations: { bold: true } },
    ]);
  });

  it('preserves the text.link on each split span', () => {
    const content = 'a'.repeat(CAP + 1);
    const span = { type: 'text', text: { content, link: { url: 'https://example.com' } } };
    const result = splitRichTextSpansToNotionLimit([span]) as { text: { link: unknown } }[];
    expect(result).toHaveLength(2);
    for (const outSpan of result) {
      expect(outSpan.text.link).toEqual({ url: 'https://example.com' });
    }
  });

  it('leaves non-text spans (mentions/equations) untouched', () => {
    const mention = { type: 'mention', mention: { type: 'user' }, plain_text: 'x'.repeat(CAP + 1) };
    const result = splitRichTextSpansToNotionLimit([mention]);
    expect(result).toEqual([mention]);
  });

  it('only splits the oversized spans in a mixed array', () => {
    const small = makeTextSpan('small');
    const big = makeTextSpan('c'.repeat(CAP + 10));
    const result = splitRichTextSpansToNotionLimit([small, big]);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(small);
  });
});

describe('extractNotionRejectedPropertyName', () => {
  it('extracts the property name from a rich_text length validation message', () => {
    const message =
      'body failed validation: body.properties.Body.rich_text[0].text.content.length should be ≤ `2000`, instead was `2602`.';
    expect(extractNotionRejectedPropertyName(message)).toBe('Body');
  });

  it('handles property names containing spaces', () => {
    const message = 'body.properties.Sale Price.number should be a number.';
    expect(extractNotionRejectedPropertyName(message)).toBe('Sale Price');
  });

  it('returns undefined when the message is not property-scoped', () => {
    expect(extractNotionRejectedPropertyName('Something went wrong')).toBeUndefined();
    expect(extractNotionRejectedPropertyName('body.parent.data_source_id is invalid')).toBeUndefined();
  });
});

describe('isNotionWritableDateBoundary', () => {
  it('accepts four-digit-year date-time and date-only values', () => {
    expect(isNotionWritableDateBoundary('2025-02-20T13:00:00.000-05:00')).toBe(true);
    expect(isNotionWritableDateBoundary('2025-02-20')).toBe(true);
    expect(isNotionWritableDateBoundary('9999-12-31T23:59:59.000Z')).toBe(true);
    expect(isNotionWritableDateBoundary('0001-01-01')).toBe(true);
  });

  it('rejects the extended-year form Notion stores as "Invalid DateTime"', () => {
    // 9999-12-31 23:59:59 rolled into year 10000 across a UTC offset (DEV-10960).
    expect(isNotionWritableDateBoundary('+010000-01-01T07:59:59.000Z')).toBe(false);
  });

  it('rejects unparseable values', () => {
    expect(isNotionWritableDateBoundary('Invalid DateTime')).toBe(false);
    expect(isNotionWritableDateBoundary('not-a-date')).toBe(false);
    expect(isNotionWritableDateBoundary('')).toBe(false);
  });

  it('rejects a nonexistent calendar date new Date() silently rolls over (DEV-11044)', () => {
    // `new Date("2026-02-29")` === 2026-03-01 (2026 is not a leap year), so a bare
    // parse check would wave it through and Notion rejects the value verbatim.
    expect(isNotionWritableDateBoundary('2026-02-29')).toBe(false);
    expect(isNotionWritableDateBoundary('2026-02-29T10:00:00.000Z')).toBe(false);
    expect(isNotionWritableDateBoundary('2024-02-29')).toBe(true); // 2024 IS a leap year
  });
});

describe('findUnwritableNotionDateBoundary', () => {
  it('returns undefined for an in-range date value', () => {
    expect(findUnwritableNotionDateBoundary({ start: '2025-02-20' })).toBeUndefined();
    expect(
      findUnwritableNotionDateBoundary({ start: '2025-02-20', end: '2025-02-21', time_zone: null }),
    ).toBeUndefined();
  });

  it('returns undefined for a null clear (no boundary to check)', () => {
    expect(findUnwritableNotionDateBoundary(null)).toBeUndefined();
  });

  it('returns the offending boundary when start is out of range', () => {
    expect(findUnwritableNotionDateBoundary({ start: '+010000-01-01T07:59:59.000Z' })).toBe(
      '+010000-01-01T07:59:59.000Z',
    );
  });

  it('returns the offending boundary when only end is out of range', () => {
    expect(findUnwritableNotionDateBoundary({ start: '2025-02-20', end: '+010000-01-01T07:59:59.000Z' })).toBe(
      '+010000-01-01T07:59:59.000Z',
    );
  });
});
