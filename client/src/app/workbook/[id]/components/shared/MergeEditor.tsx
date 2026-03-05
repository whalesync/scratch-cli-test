import { markdown } from '@codemirror/lang-markdown';
import { MergeView } from '@codemirror/merge';
import { Compartment, Extension } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { useMantineColorScheme } from '@mantine/core';
import { useEffect, useRef } from 'react';

// Simple dark theme for CodeMirror using CSS variables
const darkTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'var(--bg-base)',
      color: 'var(--fg-primary)',
    },
    '.cm-content': {
      caretColor: 'var(--fg-primary)',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--fg-primary)',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--mantine-color-gray-7)',
    },
    '.cm-gutters': {
      backgroundColor: 'var(--bg-panel)',
      color: 'var(--fg-muted)',
      borderRight: '1px solid var(--fg-divider)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'var(--bg-selected)',
    },
    '.cm-activeLine': {
      backgroundColor: 'var(--bg-selected)',
    },
  },
  { dark: true },
);

interface MergeEditorProps {
  original: string;
  modified: string;
  onModifiedChange?: (value: string) => void;
  extensions?: Extension[];
  connectionName?: string;
  originalExtensions?: Extension[];
  modifiedExtensions?: Extension[];
}

export function MergeEditor({
  original,
  modified,
  onModifiedChange,
  extensions = [],
  connectionName,
  originalExtensions = [],
  modifiedExtensions = [],
}: MergeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<MergeView | null>(null);
  const originalCompartmentRef = useRef(new Compartment());
  const modifiedCompartmentRef = useRef(new Compartment());
  const { colorScheme } = useMantineColorScheme();

  // Initialize MergeView
  useEffect(() => {
    if (!containerRef.current) return;

    const themeExtension = colorScheme === 'dark' ? darkTheme : [];
    const origCompartment = originalCompartmentRef.current;
    const modCompartment = modifiedCompartmentRef.current;

    const view = new MergeView({
      a: {
        doc: original,
        extensions: [
          markdown(),
          EditorView.editable.of(false),
          EditorView.lineWrapping,
          lineNumbers(),
          themeExtension,
          ...extensions,
          origCompartment.of(originalExtensions),
        ],
      },
      b: {
        doc: modified,
        extensions: [
          markdown(),
          EditorView.lineWrapping,
          lineNumbers(),
          themeExtension,
          EditorView.updateListener.of((update) => {
            if (update.docChanged && onModifiedChange) {
              onModifiedChange(update.state.doc.toString());
            }
          }),
          ...extensions,
          modCompartment.of(modifiedExtensions),
        ],
      },
      parent: containerRef.current,
      collapseUnchanged: { margin: 3, minSize: 4 },
    });

    viewRef.current = view;

    return () => {
      view.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colorScheme]); // Recreate when color scheme changes

  // Dynamically reconfigure original-side extensions (e.g. FK references)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.a.dispatch({ effects: originalCompartmentRef.current.reconfigure(originalExtensions) });
  }, [originalExtensions]);

  // Dynamically reconfigure modified-side extensions (e.g. FK references)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.b.dispatch({ effects: modifiedCompartmentRef.current.reconfigure(modifiedExtensions) });
  }, [modifiedExtensions]);

  // Sync original content
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentOriginal = view.a.state.doc.toString();
    if (currentOriginal !== original) {
      view.a.dispatch({
        changes: { from: 0, to: currentOriginal.length, insert: original },
      });
    }
  }, [original]);

  // Sync modified content (only if external change)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const currentModified = view.b.state.doc.toString();
    if (currentModified !== modified) {
      // Avoid circular updates if possible, but basic equality check helps
      view.b.dispatch({
        changes: { from: 0, to: currentModified.length, insert: modified },
      });
    }
  }, [modified]);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {connectionName && (
        <div
          style={{
            display: 'flex',
            borderBottom: '1px solid var(--fg-divider)',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              flex: 1,
              padding: '6px 12px',
              fontSize: '12px',
              fontWeight: 500,
              color: 'var(--fg-muted)',
              borderRight: '1px solid var(--fg-divider)',
            }}
          >
            Last {connectionName} pull
          </div>
          <div
            style={{
              flex: 1,
              padding: '6px 12px',
              fontSize: '12px',
              fontWeight: 500,
              color: 'var(--fg-muted)',
            }}
          >
            Ready to publish
          </div>
        </div>
      )}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          overflow: 'hidden',
          fontSize: '14px',
          display: 'flex',
          flexDirection: 'column',
        }}
      />
    </div>
  );
}
