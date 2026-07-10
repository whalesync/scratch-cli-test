import { Text13Regular } from '@/components/base/text';
import type { ReactNode } from 'react';
import type { WordDiffSegment } from '../../../../../shared/word-diff';

/**
 * Render word-diff segments as inline React nodes for the By-Field preview: `removed` → `<del>`
 * (delete-red, struck through), `added` → `<ins>` (create-green), and `unchanged` (including the
 * folded `…` ellipsis) as plain text. Meant to be dropped inside a parent `Text13Regular truncate`.
 *
 * Connector-agnostic — it consumes only the generic segment model, never a value's shape. Lives in
 * a component-free module (only this factory) per `react-refresh/only-export-components`.
 */
export function renderWordDiffSegments(segments: WordDiffSegment[]): ReactNode {
  return segments.map((segment, index) => {
    const key = `${segment.kind}-${index}`;
    if (segment.kind === 'removed') {
      return (
        <Text13Regular
          key={key}
          component="del"
          c="var(--delete-needs-review-stroke)"
          style={{ textDecoration: 'line-through' }}
        >
          {segment.text}
        </Text13Regular>
      );
    }
    if (segment.kind === 'added') {
      return (
        <Text13Regular
          key={key}
          component="ins"
          c="var(--create-needs-review-stroke)"
          style={{ textDecoration: 'none' }}
        >
          {segment.text}
        </Text13Regular>
      );
    }
    return <span key={key}>{segment.text}</span>;
  });
}
