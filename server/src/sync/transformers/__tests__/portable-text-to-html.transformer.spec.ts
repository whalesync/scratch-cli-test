import { PortableTextToHtmlTransformer } from '../implementations/portable-text-to-html.transformer';
import { TransformContext } from '../transformer.types';

async function transform(sourceValue: unknown) {
  return PortableTextToHtmlTransformer.transform({ sourceValue } as TransformContext);
}

function block(overrides: Record<string, unknown>): Record<string, unknown> {
  return { _type: 'block', style: 'normal', markDefs: [], children: [], ...overrides };
}

function span(text: string, marks: string[] = []): Record<string, unknown> {
  return { _type: 'span', _key: 's', text, marks };
}

describe('PortableTextToHtmlTransformer', () => {
  it('has the expected type', () => {
    expect(PortableTextToHtmlTransformer.type).toBe('portable_text_to_html');
  });

  it('renders empty string for null / non-array input', async () => {
    await expect(transform(null)).resolves.toEqual({ success: true, value: '' });
    await expect(transform('not blocks')).resolves.toEqual({ success: true, value: '' });
  });

  it('renders paragraphs, headings, and blockquotes from block styles', async () => {
    await expect(
      transform([
        block({ style: 'h2', children: [span('A heading')] }),
        block({ children: [span('Body text.')] }),
        block({ style: 'blockquote', children: [span('Quoted.')] }),
      ]),
    ).resolves.toEqual({
      success: true,
      value: '<h2>A heading</h2><p>Body text.</p><blockquote>Quoted.</blockquote>',
    });
  });

  it('renders decorator marks and link markDefs (the seeded post-second shape)', async () => {
    await expect(
      transform([
        block({
          markDefs: [{ _key: 'l1', _type: 'link', href: 'https://sanity.io' }],
          children: [span('Body with '), span('bold', ['strong']), span(' and a link', ['l1'])],
        }),
      ]),
    ).resolves.toEqual({
      success: true,
      value: '<p>Body with <strong>bold</strong><a href="https://sanity.io"> and a link</a></p>',
    });
  });

  it('escapes HTML in text and href values', async () => {
    await expect(
      transform([
        block({
          markDefs: [{ _key: 'l1', _type: 'link', href: 'https://x.test/?a=1&b="2"' }],
          children: [span('<script>alert(1)</script>', ['l1'])],
        }),
      ]),
    ).resolves.toEqual({
      success: true,
      value: '<p><a href="https://x.test/?a=1&amp;b=&quot;2&quot;">&lt;script&gt;alert(1)&lt;/script&gt;</a></p>',
    });
  });

  it('merges consecutive list blocks into nested lists by level', async () => {
    await expect(
      transform([
        block({ listItem: 'bullet', level: 1, children: [span('one')] }),
        block({ listItem: 'bullet', level: 2, children: [span('one.a')] }),
        block({ listItem: 'bullet', level: 1, children: [span('two')] }),
        block({ listItem: 'number', level: 1, children: [span('first')] }),
        block({ children: [span('after the lists')] }),
      ]),
    ).resolves.toEqual({
      success: true,
      value: '<ul><li>one</li><ul><li>one.a</li></ul><li>two</li></ul><ol><li>first</li></ol><p>after the lists</p>',
    });
  });

  it('skips custom object blocks it cannot render, keeping surrounding text', async () => {
    await expect(
      transform([
        block({ children: [span('before')] }),
        { _type: 'image', _key: 'img1', asset: { _type: 'reference', _ref: 'image-abc-100x100-png' } },
        { _type: 'customVideoEmbed', _key: 'v1', url: 'https://example.com' },
        block({ children: [span('after')] }),
      ]),
    ).resolves.toEqual({ success: true, value: '<p>before</p><p>after</p>' });
  });

  it('passes text through unwrapped for unknown decorator or annotation marks', async () => {
    await expect(
      transform([
        block({
          markDefs: [{ _key: 'c1', _type: 'comment', note: 'internal' }],
          children: [span('annotated', ['c1']), span(' styled', ['highlight'])],
        }),
      ]),
    ).resolves.toEqual({ success: true, value: '<p>annotated styled</p>' });
  });

  it('renders newlines within a span as <br>', async () => {
    await expect(transform([block({ children: [span('line1\nline2')] })])).resolves.toEqual({
      success: true,
      value: '<p>line1<br>line2</p>',
    });
  });
});
