/**
 * Pretty-printers for field values whose JSON schema declares a `contentMediaType`.
 * Used by the focused field view to render a more readable version of HTML/JSON values.
 */

const HTML_VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

const HTML_INLINE_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'br',
  'cite',
  'code',
  'em',
  'i',
  'mark',
  'q',
  's',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'wbr',
]);

function escapeHtmlText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function serializeAttrs(el: Element): string {
  let out = '';
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    out += ` ${a.name}="${escapeHtmlAttr(a.value)}"`;
  }
  return out;
}

function containsOnlyInline(el: Element): boolean {
  for (let i = 0; i < el.childNodes.length; i++) {
    const child = el.childNodes[i];
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = (child as Element).tagName.toLowerCase();
    if (!HTML_INLINE_TAGS.has(tag)) return false;
    if (!containsOnlyInline(child as Element)) return false;
  }
  return true;
}

function serializeInline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeHtmlText(node.textContent ?? '');
  if (node.nodeType === Node.COMMENT_NODE) return `<!--${node.textContent ?? ''}-->`;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const attrs = serializeAttrs(el);
  if (HTML_VOID_TAGS.has(tag)) return `<${tag}${attrs}>`;
  let inner = '';
  for (let i = 0; i < el.childNodes.length; i++) {
    inner += serializeInline(el.childNodes[i]);
  }
  return `<${tag}${attrs}>${inner}</${tag}>`;
}

function serializeBlock(node: Node, indent: number, lines: string[]): void {
  const ind = '  '.repeat(indent);
  if (node.nodeType === Node.TEXT_NODE) {
    const text = (node.textContent ?? '').trim();
    if (text) lines.push(ind + escapeHtmlText(text));
    return;
  }
  if (node.nodeType === Node.COMMENT_NODE) {
    lines.push(`${ind}<!--${node.textContent ?? ''}-->`);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const attrs = serializeAttrs(el);
  if (HTML_VOID_TAGS.has(tag)) {
    lines.push(`${ind}<${tag}${attrs}>`);
    return;
  }
  if (el.childNodes.length === 0) {
    lines.push(`${ind}<${tag}${attrs}></${tag}>`);
    return;
  }
  if (containsOnlyInline(el)) {
    let inner = '';
    for (let i = 0; i < el.childNodes.length; i++) {
      inner += serializeInline(el.childNodes[i]);
    }
    lines.push(`${ind}<${tag}${attrs}>${inner.trim()}</${tag}>`);
    return;
  }
  lines.push(`${ind}<${tag}${attrs}>`);
  for (let i = 0; i < el.childNodes.length; i++) {
    serializeBlock(el.childNodes[i], indent + 1, lines);
  }
  lines.push(`${ind}</${tag}>`);
}

function prettifyHtml(value: string): string {
  const doc = new DOMParser().parseFromString(value, 'text/html');
  const lines: string[] = [];
  for (let i = 0; i < doc.body.childNodes.length; i++) {
    serializeBlock(doc.body.childNodes[i], 0, lines);
  }
  return lines.join('\n');
}

function prettifyXml(value: string): string {
  const doc = new DOMParser().parseFromString(value, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('Invalid XML');
  }
  const lines: string[] = [];
  for (let i = 0; i < doc.childNodes.length; i++) {
    serializeBlock(doc.childNodes[i], 0, lines);
  }
  return lines.join('\n');
}

function prettifyJson(value: string): string {
  return JSON.stringify(JSON.parse(value), null, 2);
}

/** Returns true when `prettifyValue` knows how to format the given media type. */
export function isPrettifiableMediaType(mediaType: string | undefined | null): boolean {
  if (!mediaType) return false;
  const normalized = mediaType.toLowerCase().split(';')[0].trim();
  return (
    normalized === 'application/json' ||
    normalized === 'text/json' ||
    normalized === 'text/html' ||
    normalized === 'application/xhtml+xml' ||
    normalized === 'text/xml' ||
    normalized === 'application/xml'
  );
}

/**
 * Pretty-prints `value` according to `mediaType`. Returns the original value
 * unchanged if the formatter throws (e.g. invalid JSON/HTML) so callers can
 * safely treat it as a display transform.
 */
export function prettifyValue(value: string, mediaType: string): string {
  if (!value) return value;
  const normalized = mediaType.toLowerCase().split(';')[0].trim();
  try {
    if (normalized === 'application/json' || normalized === 'text/json') {
      return prettifyJson(value);
    }
    if (normalized === 'text/html' || normalized === 'application/xhtml+xml') {
      return prettifyHtml(value);
    }
    if (normalized === 'text/xml' || normalized === 'application/xml') {
      return prettifyXml(value);
    }
  } catch {
    return value;
  }
  return value;
}
