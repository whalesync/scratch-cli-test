import { Box } from '@mantine/core';
import { memo, useMemo } from 'react';
import { parseHtml } from './rich-text-sanitize';

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
