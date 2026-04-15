import { json } from '@codemirror/lang-json';
import { lintGutter, linter, type Diagnostic } from '@codemirror/lint';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { useMantineColorScheme } from '@mantine/core';
import CodeMirror from '@uiw/react-codemirror';
import { useMemo, type CSSProperties } from 'react';
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
}

export function ScratchJsonCodeMirror({
  value,
  onChange,
  readOnly = false,
  className,
  style,
  surfaceBackgroundColor,
}: ScratchJsonCodeMirrorProps) {
  const { colorScheme } = useMantineColorScheme();

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
    return exts;
  }, [readOnly, surfaceBackgroundColor]);

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
