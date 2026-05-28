import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { Box } from '@mantine/core';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';

export const COLLAPSE_HEIGHT_PX = 150;

/**
 * Wraps a grid-row div and collapses it to COLLAPSE_HEIGHT_PX when content overflows.
 * The bottom border lives on the outer wrapper so it's always visible.
 * Passes overflow/expanded state to children via render prop so the field name column
 * can render expand/collapse buttons.
 */
export function CollapsibleRow({
  children,
  expandButtonLeft,
}: {
  children: (ctx: { overflows: boolean; expanded: boolean; setExpanded: (v: boolean) => void }) => React.ReactNode;
  /** CSS `left` value for the expand/collapse button. Defaults to `'50%'`. */
  expandButtonLeft?: string;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const measure = useCallback(() => {
    if (!contentRef.current) return;
    setOverflows(contentRef.current.scrollHeight > COLLAPSE_HEIGHT_PX);
  }, []);

  // Re-measure whenever children render (content may have changed).
  useLayoutEffect(measure, [measure, children]);

  const collapsed = overflows && !expanded;

  const expandoHeight = 30;
  const gradientHeight = 40;

  return (
    <Box
      onClickCapture={
        collapsed
          ? (e) => {
              // When collapsed, clicking the row expands it — but we want native interactive
              // elements (approve/reject/discard buttons, links) to work on the first click.
              // We check for actual <button> and <a> elements only, NOT [role="button"],
              // because the value cells use role="button" on <div> wrappers and those
              // should still trigger expansion rather than entering edit mode.
              const target = e.target as HTMLElement;
              if (target.closest('button, a')) return;
              e.stopPropagation();
              setExpanded(true);
            }
          : undefined
      }
      style={{
        position: 'relative',
        borderBottom: '1px solid var(--mantine-color-default-border)',
        paddingBottom: overflows ? expandoHeight : 0,
      }}
    >
      <Box ref={contentRef} style={collapsed ? { maxHeight: COLLAPSE_HEIGHT_PX, overflow: 'hidden' } : undefined}>
        {children({ overflows, expanded, setExpanded })}
      </Box>
      {/* Fade overlay when collapsed */}
      {collapsed && (
        <Box
          pos="absolute"
          bottom={0}
          left={0}
          right={0}
          h={expandoHeight + gradientHeight}
          style={{
            background: 'linear-gradient(transparent, var(--bg-base) )',
            pointerEvents: 'none',
          }}
        />
      )}

      {/* Expand / collapse button */}
      {overflows && (
        <Box
          onClick={() => setExpanded(!expanded)}
          pos="absolute"
          bottom={0}
          h={expandoHeight}
          style={{
            left: expandButtonLeft ?? '50%',
            transform: 'translateX(-50%)',
          }}
        >
          <StyledLucideIcon Icon={expanded ? ChevronUpIcon : ChevronDownIcon} size={24} strokeWidth={1} />
        </Box>
      )}
    </Box>
  );
}
