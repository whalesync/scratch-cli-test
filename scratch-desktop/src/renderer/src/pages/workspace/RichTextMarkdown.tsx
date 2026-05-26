import { marked } from 'marked';
import { memo, useMemo } from 'react';
import { RichTextHtml } from './RichTextHtml';

interface RichTextMarkdownProps {
  markdown: string;
  muted?: boolean;
}

export const RichTextMarkdown = memo(function RichTextMarkdown({ markdown, muted = false }: RichTextMarkdownProps) {
  const html = useMemo(() => {
    if (!markdown) return '';
    try {
      return marked.parse(markdown, { async: false, gfm: true, breaks: false });
    } catch (err) {
      console.debug('RichTextMarkdown failed to parse markdown, falling back to raw text', err);
      return '';
    }
  }, [markdown]);
  return <RichTextHtml html={html} muted={muted} />;
});
