import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';

/**
 * A map of FK field names to their resolved references: { remoteId → filePath }
 */
export type ResolvedReferences = Record<string, Record<string, string>>;

class ReferenceReplaceWidget extends WidgetType {
  constructor(
    readonly filePath: string,
    readonly remoteId: string,
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.textContent = `"${this.filePath}"`;
    span.style.cssText = 'color: var(--mantine-color-blue-6, #339af0); cursor: default';
    span.title = `${this.remoteId}\n${this.filePath}`;
    return span;
  }

  eq(other: ReferenceReplaceWidget): boolean {
    return this.filePath === other.filePath && this.remoteId === other.remoteId;
  }
}

/**
 * Builds a flat lookup of remoteId → filePath from the nested ResolvedReferences structure.
 */
function buildLookup(refs: ResolvedReferences): Map<string, string> {
  const map = new Map<string, string>();
  for (const fieldRefs of Object.values(refs)) {
    for (const [remoteId, filePath] of Object.entries(fieldRefs)) {
      map.set(remoteId, filePath);
    }
  }
  return map;
}

/**
 * Scans the document for quoted strings that match FK remote IDs and replaces them visually.
 */
function buildDecorations(view: EditorView, lookup: Map<string, string>): DecorationSet {
  if (lookup.size === 0) return Decoration.none;

  const decorations: { from: number; to: number; decoration: Decoration }[] = [];
  const doc = view.state.doc;

  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    const text = line.text;

    // Match quoted strings: "someValue"
    const regex = /"([^"]+)"/g;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const value = match[1];
      const filePath = lookup.get(value);
      if (filePath) {
        const from = line.from + match.index;
        const to = from + match[0].length;
        decorations.push({
          from,
          to,
          decoration: Decoration.replace({
            widget: new ReferenceReplaceWidget(filePath, value),
          }),
        });
      }
    }
  }

  decorations.sort((a, b) => a.from - b.from);
  return Decoration.set(decorations.map((d) => d.decoration.range(d.from, d.to)));
}

/**
 * Creates a CodeMirror extension that visually replaces FK remote IDs with resolved filenames.
 */
export function fkReferenceExtension(refs: ResolvedReferences) {
  const lookup = buildLookup(refs);

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, lookup);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildDecorations(update.view, lookup);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
