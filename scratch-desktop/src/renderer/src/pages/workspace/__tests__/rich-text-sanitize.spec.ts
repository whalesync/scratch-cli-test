// @vitest-environment jsdom
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isSafeUrl, parseHtml, reactAttrName } from '../rich-text-sanitize';

/**
 * Security regression battery for the rich-text HTML sanitizer (SCR-006 / DEV-11001). The renderer
 * feeds untrusted, connector-synced record content (and the output of `marked()` on markdown fields)
 * through `parseHtml`; these tests are the "dynamic validation" the pentest asked for, pinning that
 * every dangerous construct is neutralized while safe markup survives.
 *
 * Runs under jsdom (the global vitest env is `node`) so `DOMParser` / `Node` are available.
 */

/** Render the sanitizer's React output to a static HTML string for assertions. */
function sanitizeToMarkup(html: string): string {
  return renderToStaticMarkup(createElement(Fragment, null, parseHtml(html)));
}

describe('parseHtml — dangerous constructs are neutralized', () => {
  it('drops <script> tags (renders their text inert, never a script element)', () => {
    const markup = sanitizeToMarkup('<p>before</p><script>window.__xss = 1;</script><p>after</p>');
    expect(markup).not.toContain('<script');
    expect(markup).toContain('before');
    expect(markup).toContain('after');
  });

  it('strips inline event-handler attributes (onerror/onclick/onload)', () => {
    const markup = sanitizeToMarkup('<img src="https://x/y.png" onerror="window.__xss=1" onclick="steal()">');
    expect(markup).toContain('<img');
    expect(markup).not.toContain('onerror');
    expect(markup).not.toContain('onclick');
  });

  it('rejects javascript: URLs on href and does not leak them into the title tooltip', () => {
    const markup = sanitizeToMarkup('<a href="javascript:window.__xss=1">click me</a>');
    expect(markup).not.toContain('javascript:');
    // The soft-spot fix: a rejected href must not survive as a title attribute either.
    expect(markup).not.toContain('title=');
    expect(markup).toContain('click me');
  });

  it('drops <iframe>, <object>, <embed>, <form>, and <style> while keeping their safe children', () => {
    const markup = sanitizeToMarkup(
      '<iframe src="https://evil"></iframe>' +
        '<object data="https://evil"></object>' +
        '<embed src="https://evil">' +
        '<style>@import "https://evil"</style>' +
        '<form action="https://evil"><p>kept</p></form>',
    );
    expect(markup).not.toContain('<iframe');
    expect(markup).not.toContain('<object');
    expect(markup).not.toContain('<embed');
    expect(markup).not.toContain('<style');
    expect(markup).not.toContain('<form');
    // Safe children of an unwrapped disallowed tag survive.
    expect(markup).toContain('<p>kept</p>');
  });

  it('neutralizes an <svg><script> mutation-XSS vector', () => {
    const markup = sanitizeToMarkup('<svg><script>window.__xss=1</script></svg>');
    expect(markup).not.toContain('<svg');
    expect(markup).not.toContain('<script');
  });

  it('strips namespaced attributes (xlink:href) that could smuggle a scheme', () => {
    const markup = sanitizeToMarkup('<a xlink:href="javascript:1">x</a>');
    expect(markup).not.toContain('xlink');
    expect(markup).not.toContain('javascript:');
  });

  it('rejects non-image data: URLs on <img>', () => {
    const markup = sanitizeToMarkup('<img src="data:text/html,<script>1</script>">');
    expect(markup).not.toContain('data:text/html');
  });
});

describe('parseHtml — safe markup survives with fidelity', () => {
  it('keeps block/inline formatting, lists, and tables', () => {
    const markup = sanitizeToMarkup(
      '<h1>Title</h1><p>hello <b>world</b> <em>x</em></p><ul><li>a</li></ul>' +
        '<table><tbody><tr><td colspan="2">cell</td></tr></tbody></table>',
    );
    expect(markup).toContain('<h1>Title</h1>');
    expect(markup).toContain('<b>world</b>');
    expect(markup).toContain('<li>a</li>');
    // colspan is preserved (React maps the colSpan prop back to the colspan attribute).
    expect(markup.toLowerCase()).toContain('colspan="2"');
  });

  it('renders links as non-navigable text, mirroring only a SAFE href into the title tooltip', () => {
    // By design the sanitizer never emits an `href` on <a> (rich-text links are not navigable — a
    // deliberate hardening); a safe href is surfaced only as the title tooltip.
    const markup = sanitizeToMarkup('<a href="https://example.com/path">link</a>');
    expect(markup).toContain('link');
    expect(markup).not.toContain('href=');
    expect(markup).toContain('title="https://example.com/path"');
  });

  it('keeps a data:image/svg+xml <img> src (the reviewed ENABLE_SVG_DATA_URLS decision)', () => {
    const svg = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
    const markup = sanitizeToMarkup(`<img src="${svg}" alt="ok">`);
    expect(markup).toContain(svg);
    expect(markup).toContain('alt="ok"');
  });

  it('returns [] for empty input', () => {
    expect(parseHtml('')).toEqual([]);
  });
});

describe('isSafeUrl', () => {
  it('allows web/link schemes and relative/fragment hrefs', () => {
    for (const url of ['https://x', 'http://x', 'mailto:a@b.com', 'tel:+1', '/rel', '#frag']) {
      expect(isSafeUrl(url, 'a')).toBe(true);
    }
  });

  it('rejects javascript:/vbscript:/unknown schemes (including with leading whitespace)', () => {
    for (const url of ['javascript:alert(1)', '  javascript:alert(1)  ', 'vbscript:1', 'data:text/html,x']) {
      expect(isSafeUrl(url, 'a')).toBe(false);
    }
  });

  it('allows only image data: types on <img>, rejects non-image data:', () => {
    expect(isSafeUrl('data:image/png;base64,AAAA', 'img')).toBe(true);
    expect(isSafeUrl('data:image/svg+xml;base64,AAAA', 'img')).toBe(true);
    expect(isSafeUrl('data:text/html,x', 'img')).toBe(false);
    expect(isSafeUrl('javascript:1', 'img')).toBe(false);
  });
});

describe('reactAttrName', () => {
  it('drops on* handlers and namespaced attributes', () => {
    expect(reactAttrName('onclick')).toBeNull();
    expect(reactAttrName('onerror')).toBeNull();
    expect(reactAttrName('xlink:href')).toBeNull();
  });

  it('remaps known HTML attribute names to their React equivalents', () => {
    expect(reactAttrName('class')).toBe('className');
    expect(reactAttrName('colspan')).toBe('colSpan');
    expect(reactAttrName('datetime')).toBe('dateTime');
    expect(reactAttrName('title')).toBe('title');
  });
});
