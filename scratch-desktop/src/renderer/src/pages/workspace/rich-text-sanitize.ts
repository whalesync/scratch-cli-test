import { createElement, type ReactNode } from 'react';

/**
 * HTML sanitizer for the rich-text renderer (SCR-006 / DEV-11001).
 *
 * Security model: untrusted HTML — either a `text/html` record field or the output of `marked()` on
 * a `text/markdown` field — is parsed with an inert `DOMParser` (no script execution, no resource
 * loads, no event-handler firing) and rebuilt as React elements. Crucially the parsed DOM is **never
 * re-serialized back into an HTML string / `innerHTML` sink**, which structurally avoids the
 * mutation-XSS (mXSS) class that most sanitizer bypasses rely on. On top of that we enforce a strict
 * tag allowlist, a per-tag attribute allowlist, drop every `on*`/namespaced attribute, and reject
 * dangerous URL schemes on `href`/`src`/`cite`.
 *
 * This module holds the pure logic so it can be unit-tested (the renderer's vitest env is `node`;
 * the sanitizer specs opt into `// @vitest-environment jsdom`). Keeping it out of the `.tsx` also
 * satisfies the `react-refresh/only-export-components` lint rule. `RichTextHtml.tsx` is the only
 * consumer.
 */

// SVG delivered through `<img src="data:image/svg+xml;...">` is script-inert in Chromium/Electron
// (an <img> never executes embedded scripts or runs external references), so we keep it allowed for
// rendering fidelity of inline data-URI images that connectors emit. This is a deliberate,
// reviewed decision — flip to `false` to drop the data:-URI surface entirely if it is ever unneeded.
const ENABLE_SVG_DATA_URLS = true;
// Arbitrary caps to prevent ultra deep HTML pages from causing performance issues
const MAX_HTML_DEPTH = 75;
const MAX_HTML_NODE_COUNT = 1000;

const ALLOWED_TAGS = new Set([
  'a',
  'abbr',
  'address',
  'article',
  'aside',
  'b',
  'blockquote',
  'br',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'dd',
  'del',
  'details',
  'dfn',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'ins',
  'kbd',
  'li',
  'mark',
  'ol',
  'p',
  'pre',
  'q',
  's',
  'samp',
  'section',
  'small',
  'span',
  'strong',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'time',
  'tr',
  'u',
  'ul',
  'var',
  'wbr',
]);

const VOID_TAGS = new Set(['br', 'hr', 'img', 'col', 'wbr']);

const GLOBAL_ATTR_ALLOWLIST = new Set(['title', 'lang', 'dir']);

const PER_TAG_ATTR_ALLOWLIST: Record<string, Set<string>> = {
  img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  ol: new Set(['start', 'type']),
  li: new Set(['value']),
  time: new Set(['datetime']),
  q: new Set(['cite']),
  blockquote: new Set(['cite']),
  del: new Set(['cite', 'datetime']),
  ins: new Set(['cite', 'datetime']),
};

const SAFE_URL_RE = /^(?:https?:|mailto:|tel:|#|\/)/i;
const SAFE_IMG_URL_RE = ENABLE_SVG_DATA_URLS
  ? /^(?:https?:|data:image\/(?:png|jpe?g|gif|webp|svg\+xml);)/i
  : /^(?:https?:|data:image\/(?:png|jpe?g|gif|webp);)/i;

interface ParseState {
  nodeCount: number;
  nodeLimitReached: boolean;
}

export function isSafeUrl(value: string, tag: string): boolean {
  const trimmed = value.trim();
  if (tag === 'img') return SAFE_IMG_URL_RE.test(trimmed);
  return SAFE_URL_RE.test(trimmed);
}

export function reactAttrName(name: string): string | null {
  if (name === 'class') return 'className';
  if (name === 'for') return 'htmlFor';
  if (name === 'colspan') return 'colSpan';
  if (name === 'rowspan') return 'rowSpan';
  if (name === 'datetime') return 'dateTime';
  if (name === 'tabindex') return 'tabIndex';
  if (name.startsWith('on')) return null;
  if (name.includes(':')) return null;
  return name;
}

function isAllowedAttr(tag: string, name: string): boolean {
  if (GLOBAL_ATTR_ALLOWLIST.has(name)) return true;
  return PER_TAG_ATTR_ALLOWLIST[tag]?.has(name) ?? false;
}

function buildProps(el: Element, tag: string, key: number): Record<string, unknown> {
  const props: Record<string, unknown> = { key };
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes[i];
    const name = attr.name.toLowerCase();
    if (!isAllowedAttr(tag, name)) continue;
    const value = attr.value;
    if ((name === 'href' || name === 'src' || name === 'cite') && !isSafeUrl(value, tag)) continue;
    const propName = reactAttrName(name);
    if (!propName) continue;
    props[propName] = value;
  }
  if (tag === 'a') {
    const href = el.getAttribute('href')?.trim();
    // Only surface the href in the tooltip when it passed the scheme check — otherwise a rejected
    // `javascript:`/other-scheme href would still leak into the title attribute on hover.
    if (href && isSafeUrl(href, 'a')) props.title = href;
  }
  return props;
}

function nodeToReact(node: Node, key: number, depth: number, state: ParseState): ReactNode {
  if (depth > MAX_HTML_DEPTH) {
    return null;
  }
  if (state.nodeCount >= MAX_HTML_NODE_COUNT) {
    state.nodeLimitReached = true;
    return null;
  }
  state.nodeCount += 1;
  if (state.nodeCount >= MAX_HTML_NODE_COUNT) {
    state.nodeLimitReached = true;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent ?? '';
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return null;
  }
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) {
    return childrenToReact(el, depth + 1, state);
  }
  const props = buildProps(el, tag, key);
  if (VOID_TAGS.has(tag)) {
    return createElement(tag, props);
  }
  return createElement(tag, props, childrenToReact(el, depth + 1, state));
}

function childrenToReact(parent: Node, depth: number, state: ParseState): ReactNode[] {
  const out: ReactNode[] = [];
  for (let i = 0; i < parent.childNodes.length; i++) {
    const child = nodeToReact(parent.childNodes[i], i, depth, state);
    if (child !== null && child !== '') out.push(child);
    if (state.nodeCount >= MAX_HTML_NODE_COUNT) {
      break;
    }
  }
  return out;
}

/**
 * Parse an untrusted HTML string into a sanitized array of React nodes. Disallowed tags are
 * unwrapped (their safe children are kept as text/elements); disallowed attributes and unsafe URLs
 * are dropped. Returns `[]` for empty input.
 */
export function parseHtml(html: string): ReactNode[] {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const state: ParseState = { nodeCount: 0, nodeLimitReached: false };
  const children = childrenToReact(doc.body, 1, state);
  if (state.nodeLimitReached) {
    console.debug(`RichTextHtml reached the ${MAX_HTML_NODE_COUNT}-node render limit; remaining nodes were skipped.`);
  }
  return children;
}
