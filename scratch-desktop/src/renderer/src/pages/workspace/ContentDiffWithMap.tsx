import { Box, Group, ScrollArea, SegmentedControl, UnstyledButton } from '@mantine/core';
import { ChevronDown, ChevronRight, List, Map as MapIcon } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Text12Regular, TextMono12Regular, TextMono9Regular } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';
import { getParagraphDiff, type ParagraphChangeKind } from './content-paragraph-diff';
import { InlineWordsDiff } from './diff-renderers';
import { PROSE_TEXT_STYLE, type FieldValueDiffKind } from './field-value-types';

type ViewMode = 'changes' | 'full';
type ChangedParagraphKind = Exclude<ParagraphChangeKind, 'unchanged'>;

interface TickPosition {
  changeIndex: number;
  kind: ChangedParagraphKind;
  /** Vertical position of the changed paragraph as a percentage of the scroll content height. */
  topPct: number;
}

/** Minimap tick + (full view) per-paragraph wash colors, keyed by change kind, using review-state tokens. */
const TICK_STROKE_BY_KIND: Record<ChangedParagraphKind, string> = {
  modified: 'var(--modified-needs-review-stroke)',
  created: 'var(--create-needs-review-stroke)',
  deleted: 'var(--delete-needs-review-stroke)',
};
const WASH_BG_BY_KIND: Record<ChangedParagraphKind, string> = {
  modified: 'var(--modified-needs-review-bg)',
  created: 'var(--create-needs-review-bg)',
  deleted: 'var(--delete-needs-review-bg)',
};

/** Height of the diff body (the bounded scroll pane the minimap viewport math is measured against). */
const BODY_HEIGHT = 460;
const MINIMAP_WIDTH = 60;
/** Padding above a jumped-to paragraph so it doesn't sit flush against the top edge. */
const JUMP_TOP_OFFSET = 30;

const PROSE_BODY_STYLE: CSSProperties = { color: 'var(--fg-primary)', ...PROSE_TEXT_STYLE };
const DASHED_DIVIDER_LINE = 'repeating-linear-gradient(90deg, var(--fg-divider) 0 5px, transparent 5px 9px)';

/**
 * Long-form text-field diff with a "Changes only" ⇄ "Full + map" toggle.
 *
 * - **Changes only** renders just the changed paragraphs as an inline word-level
 *   redline, collapsing each run of consecutive unchanged paragraphs into a
 *   clickable "▾ N unchanged paragraph(s)" divider.
 * - **Full + map** renders the whole body in a bounded scroll pane beside a
 *   minimap rail: one colored tick per changed paragraph (positioned by its true
 *   `offsetTop / scrollHeight`) plus a viewport box that tracks the reader's
 *   scroll; clicking a tick smooth-scrolls to that paragraph.
 *
 * Self-contained: every instance owns its own view/expansion state, scroll pane,
 * and refs, so two long-form fields on one record render independently. Reuses the
 * app's word-diff redline (`InlineWordsDiff`) and review-state color tokens; the
 * inline redline colors match the rest of the app, while change *kind* is conveyed
 * by the minimap tick color and the full-view paragraph wash.
 */
export const ContentDiffWithMap = memo(function ContentDiffWithMap({
  fromValue,
  toValue,
  diffKind,
}: {
  fromValue: string;
  toValue: string;
  diffKind: FieldValueDiffKind;
}) {
  const { entries, changeCount } = useMemo(() => getParagraphDiff(fromValue, toValue), [fromValue, toValue]);

  const [view, setView] = useState<ViewMode>('changes');
  const [expandedRunIndexes, setExpandedRunIndexes] = useState<Set<number>>(() => new Set());
  const [ticks, setTicks] = useState<TickPosition[]>([]);

  const scrollPaneRef = useRef<HTMLDivElement | null>(null);
  const scrollContentRef = useRef<HTMLDivElement | null>(null);
  const viewportBoxRef = useRef<HTMLDivElement | null>(null);
  const minimapTrackRef = useRef<HTMLDivElement | null>(null);
  const paragraphElementByChangeIndex = useRef<Map<number, HTMLElement>>(new Map());
  const pendingScrollFrameRef = useRef<number | null>(null);
  const viewportDragStateRef = useRef<{ startPointerY: number; startScrollTop: number; trackHeight: number } | null>(
    null,
  );

  const changedKindByChangeIndex = useMemo(() => {
    const map = new Map<number, ChangedParagraphKind>();
    for (const entry of entries) {
      if (entry.changeIndex != null && entry.kind !== 'unchanged') map.set(entry.changeIndex, entry.kind);
    }
    return map;
  }, [entries]);

  const registerParagraphElement = useCallback(
    (changeIndex: number) => (element: HTMLElement | null) => {
      const map = paragraphElementByChangeIndex.current;
      if (element) map.set(changeIndex, element);
      else map.delete(changeIndex);
    },
    [],
  );

  // Imperatively reposition the minimap viewport box to mirror the scroll pane.
  // Done by mutating style directly (never via state) so a ~120Hz scroll never re-renders.
  const syncViewportBox = useCallback(() => {
    const scrollPane = scrollPaneRef.current;
    const viewportBox = viewportBoxRef.current;
    if (!scrollPane || !viewportBox) return;
    const scrollHeight = scrollPane.scrollHeight || 1;
    viewportBox.style.top = `${(100 * scrollPane.scrollTop) / scrollHeight}%`;
    viewportBox.style.height = `${(100 * scrollPane.clientHeight) / scrollHeight}%`;
  }, []);

  // Recompute tick positions after layout, on scroll-pane resize, and on view/content change.
  // Only the Full view has a minimap, so this is a no-op in Changes-only mode.
  useLayoutEffect(() => {
    if (view !== 'full') return;
    const scrollPane = scrollPaneRef.current;
    if (!scrollPane) return;
    const recompute = () => {
      const scrollHeight = scrollPane.scrollHeight || 1;
      const nextTicks: TickPosition[] = [];
      paragraphElementByChangeIndex.current.forEach((element, changeIndex) => {
        const kind = changedKindByChangeIndex.get(changeIndex);
        if (!kind) return;
        nextTicks.push({ changeIndex, kind, topPct: (100 * element.offsetTop) / scrollHeight });
      });
      nextTicks.sort((first, second) => first.changeIndex - second.changeIndex);
      setTicks(nextTicks);
      syncViewportBox();
    };
    recompute();
    // Observe the content wrapper, not the fixed-height pane: ticks must re-measure
    // when the content height changes (drawer-width rewrap, late font swap), which a
    // fixed-height pane's own box size never reflects.
    const resizeObserver = new ResizeObserver(recompute);
    resizeObserver.observe(scrollContentRef.current ?? scrollPane);
    return () => resizeObserver.disconnect();
  }, [view, entries, changedKindByChangeIndex, syncViewportBox]);

  // Cancel any in-flight scroll frame on unmount.
  useEffect(
    () => () => {
      if (pendingScrollFrameRef.current != null) cancelAnimationFrame(pendingScrollFrameRef.current);
    },
    [],
  );

  const handleScrollPaneScroll = useCallback(() => {
    if (pendingScrollFrameRef.current != null) return; // Coalesce to one update per frame.
    pendingScrollFrameRef.current = requestAnimationFrame(() => {
      pendingScrollFrameRef.current = null;
      syncViewportBox();
    });
  }, [syncViewportBox]);

  const jumpToChange = useCallback((changeIndex: number) => {
    const scrollPane = scrollPaneRef.current;
    const element = paragraphElementByChangeIndex.current.get(changeIndex);
    if (!scrollPane || !element) return;
    scrollPane.scrollTo({ top: Math.max(0, element.offsetTop - JUMP_TOP_OFFSET), behavior: 'smooth' });
  }, []);

  // The viewport box doubles as a draggable scrollbar thumb: a drag covering some
  // fraction of the track scrolls the content by that same fraction of its height.
  // Pointer capture keeps the drag alive even when the pointer leaves the box/rail.
  const handleViewportPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const scrollPane = scrollPaneRef.current;
    const viewportBox = viewportBoxRef.current;
    const track = minimapTrackRef.current;
    if (!scrollPane || !viewportBox || !track) return;
    event.preventDefault();
    viewportBox.setPointerCapture(event.pointerId);
    viewportDragStateRef.current = {
      startPointerY: event.clientY,
      startScrollTop: scrollPane.scrollTop,
      trackHeight: track.clientHeight || 1,
    };
    viewportBox.style.transition = 'none'; // 1:1 tracking while dragging, no easing lag.
    viewportBox.style.cursor = 'grabbing';
  }, []);

  const handleViewportPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = viewportDragStateRef.current;
    const scrollPane = scrollPaneRef.current;
    if (!dragState || !scrollPane) return;
    const scrollHeight = scrollPane.scrollHeight || 1;
    const pointerDeltaY = event.clientY - dragState.startPointerY;
    const scrollDelta = (pointerDeltaY * scrollHeight) / dragState.trackHeight;
    const maxScrollTop = Math.max(0, scrollHeight - scrollPane.clientHeight);
    // Setting scrollTop fires the pane's scroll handler, which repositions the box.
    scrollPane.scrollTop = Math.min(maxScrollTop, Math.max(0, dragState.startScrollTop + scrollDelta));
  }, []);

  const endViewportDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const viewportBox = viewportBoxRef.current;
    viewportDragStateRef.current = null;
    if (!viewportBox) return;
    if (viewportBox.hasPointerCapture(event.pointerId)) viewportBox.releasePointerCapture(event.pointerId);
    viewportBox.style.transition = 'top 0.12s';
    viewportBox.style.cursor = 'grab';
  }, []);

  const toggleRun = useCallback((entryIndex: number) => {
    setExpandedRunIndexes((previous) => {
      const next = new Set(previous);
      if (next.has(entryIndex)) next.delete(entryIndex);
      else next.add(entryIndex);
      return next;
    });
  }, []);

  // Defensive: the drawer only routes changed fields here, but if there's nothing
  // changed just show the body plainly without the toggle/minimap chrome.
  if (changeCount === 0) {
    return <Box style={{ padding: '8px 0', ...PROSE_BODY_STYLE }}>{toValue}</Box>;
  }

  const changesOnlyBody = entries.map((entry, entryIndex) => {
    if (entry.kind === 'unchanged') {
      const isExpanded = expandedRunIndexes.has(entryIndex);
      const count = entry.unchangedCount ?? 0;
      return (
        <Box key={`run-${entryIndex}`}>
          <UnstyledButton
            onClick={() => toggleRun(entryIndex)}
            style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 0', width: '100%' }}
          >
            <StyledLucideIcon Icon={isExpanded ? ChevronDown : ChevronRight} size="sm" c="var(--fg-muted)" />
            <TextMono12Regular c="var(--fg-muted)" style={{ whiteSpace: 'nowrap', letterSpacing: '0.02em' }}>
              {count} unchanged paragraph{count === 1 ? '' : 's'}
            </TextMono12Regular>
            <Box style={{ flex: 1, height: 1, background: DASHED_DIVIDER_LINE }} />
          </UnstyledButton>
          {isExpanded && (
            <Box style={{ padding: '0 0 14px', color: 'var(--fg-secondary)', ...PROSE_TEXT_STYLE }}>{entry.to}</Box>
          )}
        </Box>
      );
    }
    return (
      <Box key={`change-${entry.changeIndex}`} style={{ marginBottom: 14 }}>
        <InlineWordsDiff variant="prose" fromValue={entry.from} value={entry.to} diffKind={diffKind} />
      </Box>
    );
  });

  const fullBody = entries.map((entry, entryIndex) => {
    if (entry.kind === 'unchanged') {
      return (
        <Box key={`run-${entryIndex}`} style={{ marginBottom: 14, color: 'var(--fg-secondary)', ...PROSE_TEXT_STYLE }}>
          {entry.to}
        </Box>
      );
    }
    const changeIndex = entry.changeIndex;
    if (changeIndex === undefined) return null; // Unreachable for changed kinds; keeps the type honest.
    return (
      <Box
        key={`change-${changeIndex}`}
        ref={registerParagraphElement(changeIndex)}
        data-change-index={changeIndex}
        style={{ marginBottom: 14, padding: '10px 14px', background: WASH_BG_BY_KIND[entry.kind] }}
      >
        <InlineWordsDiff variant="prose" fromValue={entry.from} value={entry.to} diffKind={diffKind} />
      </Box>
    );
  });

  return (
    <Box
      style={{
        border: '0.5px solid var(--fg-divider)',
        borderRadius: 4,
        overflow: 'hidden',
        backgroundColor: 'var(--bg-base)',
      }}
    >
      {/* Header: change count + the view toggle */}
      <Group
        justify="space-between"
        align="center"
        wrap="nowrap"
        style={{ padding: '8px 12px', borderBottom: '0.5px solid var(--fg-divider)' }}
      >
        <Text12Regular c="var(--fg-muted)" style={{ whiteSpace: 'nowrap' }}>
          {changeCount} change{changeCount === 1 ? '' : 's'}
        </Text12Regular>
        <SegmentedControl
          size="xs"
          value={view}
          onChange={(value) => setView(value as ViewMode)}
          data={[
            {
              value: 'changes',
              label: (
                <Group gap={6} align="center" wrap="nowrap">
                  <StyledLucideIcon Icon={List} size="sm" />
                  <span>Changes only</span>
                </Group>
              ),
            },
            {
              value: 'full',
              label: (
                <Group gap={6} align="center" wrap="nowrap">
                  <StyledLucideIcon Icon={MapIcon} size="sm" />
                  <span>Full + map</span>
                </Group>
              ),
            },
          ]}
        />
      </Group>

      {/* Body */}
      {view === 'changes' ? (
        <ScrollArea.Autosize mah={BODY_HEIGHT} type="auto">
          <Box style={{ padding: '12px 16px' }}>{changesOnlyBody}</Box>
        </ScrollArea.Autosize>
      ) : (
        <Box style={{ display: 'flex', height: BODY_HEIGHT }}>
          <Box
            ref={scrollPaneRef}
            onScroll={handleScrollPaneScroll}
            style={{ flex: 1, minWidth: 0, overflowY: 'auto', position: 'relative', padding: '12px 16px' }}
          >
            <Box ref={scrollContentRef}>{fullBody}</Box>
          </Box>
          <Box
            style={{
              width: MINIMAP_WIDTH,
              flex: 'none',
              position: 'relative',
              borderLeft: '0.5px solid var(--fg-divider)',
              backgroundColor: 'var(--bg-panel)',
            }}
          >
            <Box style={{ textAlign: 'center', paddingTop: 11 }}>
              <TextMono9Regular c="var(--fg-muted)" style={{ letterSpacing: '0.08em' }}>
                MAP
              </TextMono9Regular>
            </Box>
            <Box
              ref={minimapTrackRef}
              style={{
                position: 'absolute',
                top: 34,
                bottom: 16,
                left: 19,
                right: 19,
                background: 'var(--bg-selected)',
              }}
            >
              <Box
                ref={viewportBoxRef}
                onPointerDown={handleViewportPointerDown}
                onPointerMove={handleViewportPointerMove}
                onPointerUp={endViewportDrag}
                onPointerCancel={endViewportDrag}
                title="Drag to scroll the content"
                style={{
                  position: 'absolute',
                  left: -8,
                  right: -8,
                  top: 0,
                  height: '25%',
                  border: '1.5px solid var(--modified-needs-review-stroke)',
                  background: 'color-mix(in srgb, var(--modified-needs-review-stroke) 8%, transparent)',
                  cursor: 'grab',
                  touchAction: 'none',
                  userSelect: 'none',
                  zIndex: 2,
                  transition: 'top 0.12s',
                }}
              />
              {ticks.map((tick) => (
                <Box
                  key={tick.changeIndex}
                  onClick={() => jumpToChange(tick.changeIndex)}
                  title={`Change ${tick.changeIndex}`}
                  style={{
                    position: 'absolute',
                    left: -8,
                    right: -8,
                    top: `${tick.topPct}%`,
                    height: 6,
                    background: TICK_STROKE_BY_KIND[tick.kind],
                    cursor: 'pointer',
                  }}
                />
              ))}
            </Box>
          </Box>
        </Box>
      )}
    </Box>
  );
});
