import { json } from '@codemirror/lang-json';
import { syntaxTree } from '@codemirror/language';
import { lintGutter, linter, type Diagnostic } from '@codemirror/lint';
import { EditorState, type Extension } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  ViewPlugin,
  hoverTooltip,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import { useMantineColorScheme } from '@mantine/core';
import CodeMirror from '@uiw/react-codemirror';
import { useMemo, useRef, type CSSProperties } from 'react';
import { diagnoseJsonRecordText } from '../utils/json-record-diagnostics';

/** Maps record JSON rules (parse + top-level object) to CodeMirror diagnostics for gutter + squiggles. */
function recordJsonLintDiagnostics(text: string): Diagnostic[] {
  const d = diagnoseJsonRecordText(text);
  if (d.status === 'ok') {
    return [];
  }
  const severity = 'error' as const;
  const len = text.length;
  if (d.status === 'empty') {
    return [{ from: 0, to: len === 0 ? 0 : 1, message: d.message, severity }];
  }
  if (d.status === 'not_object') {
    const from = len === 0 ? 0 : Math.min(Math.max(0, d.position), len - 1);
    return [{ from, to: Math.min(from + 1, len), message: d.message, severity }];
  }
  if (d.status === 'parse') {
    if ('position' in d) {
      const from = len === 0 ? 0 : Math.min(Math.max(0, d.position), len - 1);
      return [{ from, to: Math.min(from + 1, len), message: d.message, severity }];
    }
    return [{ from: 0, to: len ? 1 : 0, message: d.message, severity }];
  }
  return [];
}

const recordJsonLinter = linter((view: EditorView) => recordJsonLintDiagnostics(view.state.doc.toString()), {
  delay: 250,
});

/** Mirrors web client `FileViewer` / `ScratchFileViewer` CodeMirror setup. */
const basicSetupInteractive = {
  lineNumbers: true,
  highlightActiveLineGutter: true,
  highlightSpecialChars: true,
  history: true,
  foldGutter: true,
  drawSelection: true,
  dropCursor: true,
  allowMultipleSelections: true,
  indentOnInput: true,
  syntaxHighlighting: true,
  bracketMatching: true,
  closeBrackets: true,
  autocompletion: true,
  rectangularSelection: true,
  crosshairCursor: true,
  highlightActiveLine: true,
  highlightSelectionMatches: true,
  closeBracketsKeymap: true,
  defaultKeymap: true,
  searchKeymap: true,
  historyKeymap: true,
  foldKeymap: true,
  completionKeymap: true,
  lintKeymap: true,
} as const;

const basicSetupReadOnly = {
  ...basicSetupInteractive,
  history: false,
  dropCursor: false,
  indentOnInput: false,
  closeBrackets: false,
  autocompletion: false,
  highlightActiveLine: false,
  closeBracketsKeymap: false,
  historyKeymap: false,
  completionKeymap: false,
} as const;

/**
 * Build the dot-path for a `PropertyName` node by walking up the Lezer JSON tree.
 * E.g. for `{"address":{"city":"NYC"}}`, hovering `city` returns `"address.city"`.
 */
function buildJsonPath(
  node: { name: string; parent: typeof node | null; from: number; to: number },
  state: { doc: { sliceString: (from: number, to: number) => string } },
): string {
  const parts: string[] = [];
  let cur: typeof node | null = node;
  while (cur) {
    if (cur.name === 'PropertyName') {
      const raw = state.doc.sliceString(cur.from, cur.to);
      parts.unshift(raw.replace(/^"|"$/g, ''));
    } else if (cur.name === 'Array') {
      // When inside an array, find which child index the previous node was at.
      // Walk up to the Property that owns this array — that's already captured.
      // We insert the numeric index of the element.
      const child = cur.parent?.name === 'Property' ? undefined : cur;
      if (child) {
        // Skip — array at top level is unusual for record JSON
      }
    }
    cur = cur.parent;
  }
  return parts.join('.');
}

export interface ColumnHoverCallbacks {
  onAddColumn: (path: string) => void;
  onToggleColumnVisible: (path: string) => void;
  /** All column paths in the view (visible + hidden). */
  allColumns: Set<string>;
  /** Column paths currently visible in the grid. */
  visibleColumns: Set<string>;
}

function createTooltipButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.style.fontSize = '12px';
  btn.style.cursor = 'pointer';
  btn.style.border = 'none';
  btn.style.background = 'transparent';
  btn.style.color = 'var(--fg-primary)';
  btn.style.padding = '0';
  btn.textContent = label;
  btn.addEventListener('mousedown', (e) => {
    e.preventDefault();
    onClick();
  });
  return btn;
}

function columnHoverExtension(callbacksRef: { current: ColumnHoverCallbacks | undefined }): Extension {
  return hoverTooltip(
    (view, pos) => {
      const tree = syntaxTree(view.state);
      const node = tree.resolveInner(pos);
      if (node.name !== 'PropertyName') return null;

      const path = buildJsonPath(node, view.state);
      if (!path) return null;

      return {
        pos: node.from,
        end: node.to,
        above: true,
        create: () => {
          const container = document.createElement('div');
          container.style.padding = '2px 6px';
          container.style.borderRadius = '6px';
          container.style.border = '1px solid var(--fg-divider)';
          container.style.background = 'var(--bg-base)';
          container.style.boxShadow = '0 2px 8px rgba(0,0,0,0.12)';

          const cb = callbacksRef.current;
          const isExisting = cb?.allColumns.has(path);

          if (isExisting) {
            const visible = cb?.visibleColumns.has(path) ?? false;
            container.appendChild(
              createTooltipButton(visible ? 'Hide column' : 'Show column', () => cb?.onToggleColumnVisible(path)),
            );
          } else {
            container.appendChild(
              createTooltipButton('Add to columns', () => {
                cb?.onAddColumn(path);
                // Transition to "Hide column" as feedback
                container.innerHTML = '';
                container.appendChild(createTooltipButton('Hide column', () => cb?.onToggleColumnVisible(path)));
              }),
            );
          }

          return { dom: container };
        },
      };
    },
    { hoverTime: 0 },
  );
}

const columnKeyMark = Decoration.mark({ class: 'cm-column-key' });

function buildColumnDecorations(view: EditorView, allColumns: Set<string> | undefined): DecorationSet {
  if (!allColumns || allColumns.size === 0) return Decoration.none;
  const builder: { from: number; to: number }[] = [];
  const tree = syntaxTree(view.state);
  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (nodeRef) => {
        if (nodeRef.name !== 'PropertyName') return;
        const node = nodeRef.node;
        const path = buildJsonPath(node, view.state);
        if (path && allColumns.has(path)) {
          builder.push({ from: node.from, to: node.to });
        }
      },
    });
  }
  builder.sort((a, b) => a.from - b.from);
  let deco = Decoration.none;
  if (builder.length > 0) {
    const ranges = builder.map((r) => columnKeyMark.range(r.from, r.to));
    deco = Decoration.set(ranges);
  }
  return deco;
}

function columnHighlightExtension(callbacksRef: { current: ColumnHoverCallbacks | undefined }): Extension[] {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildColumnDecorations(view, callbacksRef.current?.allColumns);
      }
      update(update: ViewUpdate) {
        // Rebuild on doc, viewport, or any state change (to pick up ref changes during interaction).
        if (update.docChanged || update.viewportChanged || update.selectionSet) {
          this.decorations = buildColumnDecorations(update.view, callbacksRef.current?.allColumns);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  const theme = EditorView.baseTheme({
    '.cm-column-key': {
      textDecoration: 'underline',
      textDecorationColor: 'var(--fg-muted)',
      textUnderlineOffset: '2px',
    },
  });

  return [plugin, theme];
}

export interface ScratchJsonCodeMirrorProps {
  value: string;
  /** Omit or pass no-op when `readOnly` — CodeMirror still receives a handler. */
  onChange?: (value: string) => void;
  readOnly?: boolean;
  className?: string;
  style?: CSSProperties;
  /**
   * When set, applies this background to the editor root, scroller, and gutters so the
   * CodeMirror surface matches a parent container (e.g. delete diff wash colors).
   */
  surfaceBackgroundColor?: string;
  /** When set, hovering a JSON key shows column tooltips (add / show-hide toggle). */
  columnHover?: ColumnHoverCallbacks;
}

export function ScratchJsonCodeMirror({
  value,
  onChange,
  readOnly = false,
  className,
  style,
  surfaceBackgroundColor,
  columnHover,
}: ScratchJsonCodeMirrorProps) {
  const { colorScheme } = useMantineColorScheme();

  // Stable ref so the hover extension doesn't need to be recreated when callbacks/sets change.
  const columnHoverRef = useRef(columnHover);
  columnHoverRef.current = columnHover;

  const extensions = useMemo(() => {
    const exts = [json(), EditorView.lineWrapping, lintGutter(), recordJsonLinter];
    if (readOnly) {
      exts.push(EditorView.editable.of(false), EditorState.readOnly.of(true));
    }
    if (surfaceBackgroundColor) {
      exts.push(
        EditorView.theme({
          '&': { backgroundColor: surfaceBackgroundColor },
          '.cm-scroller': { backgroundColor: surfaceBackgroundColor },
          '.cm-gutters': { backgroundColor: surfaceBackgroundColor },
        }),
      );
    }
    if (columnHover) {
      exts.push(columnHoverExtension(columnHoverRef), ...columnHighlightExtension(columnHoverRef));
    }
    return exts;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- columnHover presence (not identity) controls whether the extension is added
  }, [readOnly, surfaceBackgroundColor, !!columnHover]);

  const handleChange = onChange ?? (() => undefined);

  return (
    <CodeMirror
      value={value}
      onChange={handleChange}
      extensions={extensions}
      theme={colorScheme === 'dark' ? 'dark' : 'light'}
      editable={!readOnly}
      basicSetup={readOnly ? basicSetupReadOnly : basicSetupInteractive}
      className={className}
      style={{
        fontSize: '13px',
        height: '100%',
        ...style,
      }}
    />
  );
}
