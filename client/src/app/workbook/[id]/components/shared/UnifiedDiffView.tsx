'use client';

import { json } from '@codemirror/lang-json';
import { unifiedMergeView } from '@codemirror/merge';
import { EditorView, lineNumbers } from '@codemirror/view';
import { useEffect, useRef } from 'react';

/**
 * A plain CodeMirror editor grows to fit its document, so without this the editor
 * overflows its container and the modal clips it. Pinning the editor to the
 * container's height makes the editor's own scroller take over.
 */
const fillContainerAndScrollTheme = EditorView.theme({
  '&': { height: '100%' },
  '.cm-scroller': { overflow: 'auto' },
});

/**
 * Read-only unified (inline) diff of two JSON documents, rendered with CodeMirror's
 * `unifiedMergeView`. Deleted lines from `original` are shown inline above the
 * `modified` lines that replaced them.
 */
export function UnifiedDiffView({ original, modified }: { original: string; modified: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const view = new EditorView({
      doc: modified,
      extensions: [
        json(),
        EditorView.editable.of(false),
        EditorView.lineWrapping,
        lineNumbers(),
        fillContainerAndScrollTheme,
        unifiedMergeView({
          original,
          mergeControls: false,
        }),
      ],
      parent: containerRef.current,
    });

    return () => view.destroy();
  }, [original, modified]);

  return <div ref={containerRef} style={{ height: '100%', overflow: 'hidden' }} />;
}
