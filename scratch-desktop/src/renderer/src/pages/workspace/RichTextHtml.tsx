import { Box } from '@mantine/core';
import { createElement, memo, useMemo, type ReactNode } from 'react';

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

function isSafeUrl(value: string, tag: string): boolean {
  const trimmed = value.trim();
  if (tag === 'img') return SAFE_IMG_URL_RE.test(trimmed);
  return SAFE_URL_RE.test(trimmed);
}

function reactAttrName(name: string): string | null {
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
    if (href) props.title = href;
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

function parseHtml(html: string): ReactNode[] {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const state: ParseState = { nodeCount: 0, nodeLimitReached: false };
  const children = childrenToReact(doc.body, 1, state);
  if (state.nodeLimitReached) {
    console.debug(`RichTextHtml reached the ${MAX_HTML_NODE_COUNT}-node render limit; remaining nodes were skipped.`);
  }
  return children;
}

interface RichTextHtmlProps {
  html: string;
  muted?: boolean;
}

export const RichTextHtml = memo(function RichTextHtml({ html, muted = false }: RichTextHtmlProps) {
  const children = useMemo(() => parseHtml(html), [html]);
  if (children.length === 0) {
    return <Box style={{ padding: '8px 12px', color: 'var(--fg-muted)', fontSize: 13 }}>{'—'}</Box>;
  }
  return (
    <Box
      className="scratch-rich-text"
      style={{
        // The horizontal padding has to leave room for default list markers, which render
        // outside the content box of <ul>/<ol> (list-style-position: outside).
        padding: '12px 16px',
        fontSize: 14,
        lineHeight: 1.55,
        color: muted ? 'var(--fg-muted)' : 'var(--fg-primary)',
        wordBreak: 'break-word',
      }}
    >
      {/* Scoped typography — Mantine globals reset ul/ol/headings, so we re-add the
          spacing the rich-text renderer expects. */}
      <style>{`
        .scratch-rich-text > :first-child { margin-top: 0; }
        .scratch-rich-text > :last-child { margin-bottom: 0; }
        .scratch-rich-text p { margin: 0 0 0.75em; }
        .scratch-rich-text h1, .scratch-rich-text h2, .scratch-rich-text h3,
        .scratch-rich-text h4, .scratch-rich-text h5, .scratch-rich-text h6 {
          margin: 1em 0 0.5em; line-height: 1.25; font-weight: 600;
        }
        .scratch-rich-text h1 { font-size: 1.6em; }
        .scratch-rich-text h2 { font-size: 1.4em; }
        .scratch-rich-text h3 { font-size: 1.2em; }
        .scratch-rich-text h4 { font-size: 1.05em; }
        .scratch-rich-text ul, .scratch-rich-text ol { margin: 0.5em 0; padding-inline-start: 1.75em; }
        .scratch-rich-text li { margin: 0.15em 0; }
        .scratch-rich-text li > ul, .scratch-rich-text li > ol { margin: 0.15em 0; }
        .scratch-rich-text blockquote {
          margin: 0.75em 0; padding: 0.25em 0.9em; border-left: 3px solid var(--fg-divider);
          color: var(--fg-secondary);
        }
        .scratch-rich-text pre {
          margin: 0.75em 0; padding: 0.75em; background: var(--bg-panel);
          border-radius: 4px; overflow-x: auto; font-size: 0.9em;
        }
        .scratch-rich-text code { font-family: var(--font-mono, monospace); font-size: 0.9em; }
        .scratch-rich-text a { color: var(--fg-link); text-decoration: underline; }
        .scratch-rich-text img { max-width: 100%; height: auto; }
        .scratch-rich-text table { border-collapse: collapse; margin: 0.75em 0; }
        .scratch-rich-text th, .scratch-rich-text td {
          border: 1px solid var(--fg-divider); padding: 0.3em 0.6em;
        }
        .scratch-rich-text hr { border: 0; border-top: 1px solid var(--fg-divider); margin: 1em 0; }
      `}</style>
      {children}
    </Box>
  );
});
