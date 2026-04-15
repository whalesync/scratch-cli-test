/**
 * Client-side checks matching main-process record JSON rules: top-level object only.
 * Used to show parse issues in the invalid-file editor.
 */

export type JsonRecordDiagnostic =
  | { status: 'ok' }
  | { status: 'empty'; message: string }
  | { status: 'parse'; message: string; position: number }
  | { status: 'parse'; message: string }
  | { status: 'not_object'; message: string; position: number };

/** V8-style: `Unexpected token ... in JSON at position 12` */
export function extractJsonParsePosition(message: string, textLength: number): number | undefined {
  const m = message.match(/position\s+(\d+)/i);
  if (!m) return undefined;
  const p = Number.parseInt(m[1], 10);
  if (Number.isNaN(p) || p < 0) return undefined;
  if (textLength === 0) return 0;
  return Math.min(p, textLength - 1);
}

export function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
  const o = Math.max(0, Math.min(offset, text.length));
  const before = text.slice(0, o);
  const line = (before.match(/\n/g) ?? []).length + 1;
  const lastNl = before.lastIndexOf('\n');
  const column = o - (lastNl === -1 ? 0 : lastNl + 1) + 1;
  return { line, column };
}

function firstNonObjectValuePosition(text: string): number {
  const t = text.trimStart();
  if (t.startsWith('[')) {
    const i = text.indexOf('[');
    return i >= 0 ? i : 0;
  }
  const m = text.match(/\S/);
  return m?.index ?? 0;
}

export function diagnoseJsonRecordText(text: string): JsonRecordDiagnostic {
  if (text.trim().length === 0) {
    return { status: 'empty', message: 'File is empty.' };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { status: 'ok' };
    }
    return {
      status: 'not_object',
      message: 'Top-level JSON must be an object `{ ... }`, not an array or primitive.',
      position: firstNonObjectValuePosition(text),
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const position = extractJsonParsePosition(message, text.length);
    if (position !== undefined) {
      return { status: 'parse', message, position };
    }
    return { status: 'parse', message };
  }
}
