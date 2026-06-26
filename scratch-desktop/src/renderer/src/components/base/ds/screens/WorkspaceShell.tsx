// A faithful, self-contained reproduction of the Scratch desktop app's HERO screen — the main
// workspace view a user lives in: the top toolbar, the left folder tree, and the data grid showing
// a connector folder's records (with the published -> approved -> local review-state coloring on
// changed rows). Built for /design-sync so Claude Design has an accurate picture of what the app
// actually looks like today. Reproduced from the real components + a live screenshot of the running
// app (DEV-10592); the real grid is a <canvas> (glide-data-grid), faithfully re-expressed here as
// DOM. Carries its own example data; no IPC / router / store / data fetching.
import { Box, Group, Stack } from '@mantine/core';
import {
  ChevronDown,
  ChevronRight,
  Columns3,
  Database,
  ExternalLink,
  Folder,
  RefreshCw,
  Rows3,
  ScrollText,
  Settings,
  Settings2,
  ShieldCheck,
  Table2,
  Unplug,
  UploadCloud,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { ButtonSecondaryGhost } from '../../buttons';
import { Text12Medium, Text12Regular, Text13Medium, Text13Regular, TextMono12Regular } from '../../text';

// ── Data shape (mirrors the real grid's row/column model) ────────────────────────
type ReviewState = 'clean' | 'needs-review' | 'approved';
// The real grid renders a changed cell as the NEW value inline, with the changed words highlighted
// (word diff) — it does NOT show "old → new". A segment flagged `changed` renders in the diff color.
interface DiffSeg {
  text: string;
  changed?: boolean;
}
interface BlogRow {
  name: string;
  slug: string;
  lastPublished: string;
  createdOn: string;
  postBody: string;
  topic: string;
  review: ReviewState;
  /** When the row is changed, the word-diff segments for the Last Published cell. */
  lastPublishedDiff?: DiffSeg[];
}

// ── Fixture data — themed to the real "Blog Posts (Demo)" Webflow collection ──────
const ROWS: BlogRow[] = [
  {
    name: 'Building a Balanced Cocktail Spirit',
    slug: 'balanced-cocktail',
    lastPublished: 'Jun 28, 2026',
    createdOn: 'Jun 22, 2026',
    postBody: '<h2>Three flavor pillars…',
    topic: 'Cocktails',
    review: 'needs-review',
    lastPublishedDiff: [{ text: 'Jun ' }, { text: '28', changed: true }, { text: ', 2026' }],
  },
  {
    name: 'How to Brew the Perfect Cup of Green Tea',
    slug: 'how-perfect-green',
    lastPublished: 'Jun 28, 2026',
    createdOn: 'Jun 22, 2026',
    postBody: '<h2>Gentle heat, short steep…',
    topic: 'Tea',
    review: 'needs-review',
    lastPublishedDiff: [{ text: 'Jun ' }, { text: '28', changed: true }, { text: ', 2026' }],
  },
  {
    name: 'Brewing Kombucha: Your First Batch',
    slug: 'brewing-kombucha',
    lastPublished: 'Jun 28, 2026',
    createdOn: 'Jun 22, 2026',
    postBody: '<h2>A 7-step starter…',
    topic: 'Fermentation',
    review: 'approved',
    lastPublishedDiff: [{ text: 'Jun ' }, { text: '28', changed: true }, { text: ', 2026' }],
  },
  {
    name: 'Building Your First Cheese Board',
    slug: 'building-cheese-board',
    lastPublished: 'Jun 28, 2026',
    createdOn: 'Jun 22, 2026',
    postBody: '<h2>Pair soft and hard…',
    topic: 'Cheese',
    review: 'clean',
  },
  {
    name: 'Choosing the Right Drink Size for Your Café',
    slug: 'choosing-drink-size',
    lastPublished: 'Jun 28, 2026',
    createdOn: 'Jun 22, 2026',
    postBody: '<h2>Match the cup…',
    topic: 'Coffee',
    review: 'clean',
  },
  {
    name: 'Choosing Wood for Your Smoker',
    slug: 'choosing-wood',
    lastPublished: 'Jun 28, 2026',
    createdOn: 'Jun 22, 2026',
    postBody: '<h2>Hickory vs. oak…',
    topic: 'BBQ',
    review: 'clean',
  },
  {
    name: "Choosing Your First Chef's Knife",
    slug: 'choosing-your-knife',
    lastPublished: 'Jun 28, 2026',
    createdOn: 'Jun 22, 2026',
    postBody: '<h2>Balance and grip…',
    topic: 'Knife Skills',
    review: 'clean',
  },
  {
    name: 'Cooking Pasta Like a Nonna',
    slug: 'cook-pasta-al-dente',
    lastPublished: 'Jun 28, 2026',
    createdOn: 'Jun 22, 2026',
    postBody: '<h2>Salt the water…',
    topic: 'Pasta',
    review: 'clean',
  },
  {
    name: 'Dialing In Espresso Extraction',
    slug: 'espresso-extraction',
    lastPublished: 'Jun 28, 2026',
    createdOn: 'Jun 22, 2026',
    postBody: '<h2>Time, dose, yield…',
    topic: 'Coffee',
    review: 'clean',
  },
  {
    name: 'Direct vs. Indirect Heat on the Grill',
    slug: 'direct-indirect-heat',
    lastPublished: 'Jun 28, 2026',
    createdOn: 'Jun 22, 2026',
    postBody: '<h2>When to sear…',
    topic: 'BBQ',
    review: 'clean',
  },
  {
    name: 'The Four Knife Cuts Every Cook Knows',
    slug: 'knife-cuts-cook',
    lastPublished: 'Jun 28, 2026',
    createdOn: 'Jun 22, 2026',
    postBody: '<h2>Dice, julienne…',
    topic: 'Knife Skills',
    review: 'clean',
  },
  {
    name: 'Fresh vs. Dried Pasta: When to Use Each',
    slug: 'fresh-vs-dried',
    lastPublished: 'Jun 28, 2026',
    createdOn: 'Jun 22, 2026',
    postBody: '<h2>Not better, different…',
    topic: 'Pasta',
    review: 'clean',
  },
];

const FOLDERS = [
  { name: 'Assets', count: 1, depth: 3, selected: false, icon: 'folder' as const },
  { name: 'Blog Posts (Demo)', count: 40, depth: 3, selected: true, icon: 'table' as const },
  { name: 'Mackerels', count: 11, depth: 3, selected: false, icon: 'table' as const },
  { name: 'Menu Items', count: 5, depth: 3, selected: false, icon: 'table' as const },
  { name: 'Recipes', count: 5, depth: 3, selected: false, icon: 'table' as const },
];

// kind=modified review-state token pair for the row tint + status stroke.
function modifiedTokens(review: ReviewState): { bg: string; stroke: string } {
  if (review === 'needs-review')
    return { bg: 'var(--modified-needs-review-bg)', stroke: 'var(--modified-needs-review-stroke)' };
  return { bg: 'var(--modified-approved-bg)', stroke: 'var(--modified-approved-stroke)' };
}

// ── Header (40px toolbar) ─────────────────────────────────────────────────────────
function WorkspaceChrome() {
  return (
    <Group
      h={40}
      px={8}
      gap={0}
      justify="space-between"
      wrap="nowrap"
      style={{ borderBottom: '1px solid var(--fg-divider)', flexShrink: 0, background: 'var(--bg-base)' }}
    >
      <Group gap={8} wrap="nowrap">
        <Box
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            background: 'var(--highlight-fill)',
            border: '1px solid var(--highlight-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: 'none',
          }}
        >
          <Database size={15} color="var(--highlight-text)" />
        </Box>
        <Group gap={4} wrap="nowrap">
          <Text13Medium c="var(--fg-primary)">QA Webflow</Text13Medium>
          <ChevronDown size={14} color="var(--fg-muted)" />
        </Group>
      </Group>
      <Group gap={4} wrap="nowrap">
        <ButtonSecondaryGhost size="xs" leftSection={<ExternalLink size={14} />}>
          Open in…
        </ButtonSecondaryGhost>
        <ButtonSecondaryGhost size="xs" leftSection={<RefreshCw size={14} />}>
          Re-download files
        </ButtonSecondaryGhost>
        <ButtonSecondaryGhost size="xs" leftSection={<RefreshCw size={14} />}>
          Pull all
        </ButtonSecondaryGhost>
        <ButtonSecondaryGhost size="xs" leftSection={<UploadCloud size={14} />}>
          Publish all
        </ButtonSecondaryGhost>
      </Group>
    </Group>
  );
}

// ── Sidebar: folder tree + bottom nav ─────────────────────────────────────────────
function TreeRow({
  label,
  depth,
  hasChildren,
  expanded,
  icon,
  count,
  selected,
}: {
  label: string;
  depth: number;
  hasChildren?: boolean;
  expanded?: boolean;
  icon?: 'folder' | 'table' | 'connector';
  count?: number;
  selected?: boolean;
}) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  return (
    <Group
      gap={4}
      wrap="nowrap"
      style={{
        width: '100%',
        paddingLeft: 8 + depth * 16,
        paddingRight: 8,
        paddingTop: 4,
        paddingBottom: 4,
        background: selected ? 'var(--highlight-fill)' : undefined,
      }}
    >
      {hasChildren ? (
        <Chevron size={14} color="var(--fg-muted)" style={{ flex: 'none' }} />
      ) : (
        <Box style={{ width: 14, flex: 'none' }} />
      )}
      {icon === 'connector' ? (
        <Database size={14} color="var(--fg-secondary)" style={{ flex: 'none' }} />
      ) : icon === 'table' ? (
        <Table2 size={14} color="var(--fg-secondary)" style={{ flex: 'none' }} />
      ) : icon === 'folder' ? (
        <Folder size={14} color="var(--fg-secondary)" style={{ flex: 'none' }} />
      ) : (
        <Box style={{ width: 14, flex: 'none' }} />
      )}
      <Text13Regular c={selected ? 'var(--highlight-text)' : 'var(--fg-primary)'} truncate style={{ flex: 1 }}>
        {label}
      </Text13Regular>
      {count !== undefined && (
        <Text12Regular c="var(--fg-muted)" style={{ flex: 'none' }}>
          {count}
        </Text12Regular>
      )}
    </Group>
  );
}

function NavRow({ icon, label, right }: { icon: ReactNode; label: string; right?: ReactNode }) {
  return (
    <Group gap={8} wrap="nowrap" justify="space-between" px={12} py={8} style={{ width: '100%' }}>
      <Group gap={8} wrap="nowrap">
        {icon}
        <Text13Regular c="var(--fg-secondary)">{label}</Text13Regular>
      </Group>
      {right}
    </Group>
  );
}

function Sidebar() {
  return (
    <Stack
      gap={0}
      style={{
        width: 280,
        flexShrink: 0,
        background: 'var(--bg-base)',
        border: '0.5px solid var(--fg-divider)',
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      <Box style={{ flex: 1, overflow: 'hidden', paddingTop: 8, paddingBottom: 8 }}>
        <TreeRow label="Scratch" depth={0} hasChildren expanded icon="folder" />
        <TreeRow label="QA Webflow" depth={1} hasChildren expanded icon="connector" />
        <TreeRow label="Scratch General Test with E-Comm" depth={2} hasChildren expanded icon="folder" />
        <TreeRow label="Collections" depth={2} hasChildren expanded icon="folder" />
        {FOLDERS.map((f) => (
          <TreeRow key={f.name} label={f.name} depth={f.depth} icon={f.icon} count={f.count} selected={f.selected} />
        ))}
      </Box>
      <Box px={12} py={6} style={{ borderTop: '1px solid var(--fg-divider)' }}>
        <Text12Regular c="var(--fg-muted)" ta="right">
          62 total files
        </Text12Regular>
      </Box>
      <Box py={8} style={{ borderTop: '1px solid var(--fg-divider)' }}>
        <NavRow icon={<Unplug size={14} color="var(--fg-secondary)" />} label="Connections" />
        <NavRow
          icon={<ShieldCheck size={14} color="var(--fg-secondary)" />}
          label="Validation"
          right={
            <Box style={{ padding: '1px 7px', borderRadius: 4, background: 'var(--bg-selected)' }}>
              <TextMono12Regular c="var(--fg-muted)">off</TextMono12Regular>
            </Box>
          }
        />
        <NavRow icon={<ScrollText size={14} color="var(--fg-secondary)" />} label="Publish History" />
        <NavRow icon={<Settings size={14} color="var(--fg-secondary)" />} label="Workspace Settings" />
        <NavRow
          icon={
            <Box
              style={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                background: 'var(--bg-selected)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text12Medium c="var(--fg-secondary)">t</Text12Medium>
            </Box>
          }
          label="testing@whalesync.com"
        />
      </Box>
    </Stack>
  );
}

// ── Grid: filter toolbar + table + status bar ─────────────────────────────────────
function FilterPill({ label, count, dot, active }: { label: string; count: number; dot: string; active?: boolean }) {
  return (
    <Group
      gap={4}
      wrap="nowrap"
      style={{
        padding: '2px 8px',
        borderRadius: 10,
        border: active ? '1.5px solid var(--highlight-border)' : '0.5px solid var(--fg-divider)',
        background: active ? 'var(--highlight-fill)' : 'transparent',
      }}
    >
      <Box style={{ width: 8, height: 8, borderRadius: '50%', background: dot, flex: 'none' }} />
      <Text12Medium c={active ? 'var(--highlight-text)' : 'var(--fg-muted)'}>
        {label} ({count})
      </Text12Medium>
    </Group>
  );
}

function ToolbarIcon({ children, active }: { children: ReactNode; active?: boolean }) {
  return (
    <Box
      style={{
        width: 26,
        height: 24,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: active ? 'var(--bg-selected)' : 'transparent',
      }}
    >
      {children}
    </Box>
  );
}

function GridToolbar() {
  const needsReview = ROWS.filter((r) => r.review === 'needs-review').length;
  const approved = ROWS.filter((r) => r.review === 'approved').length;
  return (
    <Group gap={12} wrap="nowrap" p={6} style={{ borderBottom: '0.5px solid var(--fg-divider)' }}>
      <Group
        gap={0}
        wrap="nowrap"
        style={{ border: '1px solid var(--fg-divider)', borderRadius: 4, overflow: 'hidden' }}
      >
        <ToolbarIcon active>
          <Table2 size={15} color="var(--fg-secondary)" />
        </ToolbarIcon>
        <ToolbarIcon>
          <Rows3 size={15} color="var(--fg-muted)" />
        </ToolbarIcon>
      </Group>
      <Group gap={8} wrap="nowrap">
        <Text12Medium c="var(--fg-muted)">Filter</Text12Medium>
        <FilterPill label="Needs review" count={needsReview} dot="var(--modified-needs-review-stroke)" />
        <FilterPill label="Approved" count={approved} dot="var(--modified-approved-stroke)" />
        <FilterPill label="Problems" count={0} dot="var(--mantine-color-red-6)" />
      </Group>
      <Box style={{ flex: 1 }} />
      <ButtonSecondaryGhost size="xs" leftSection={<Columns3 size={14} />}>
        Columns
      </ButtonSecondaryGhost>
      <Settings2 size={16} color="var(--fg-muted)" />
    </Group>
  );
}

// Grid column layout. Status col + the visible data columns (a faithful subset of the real 11).
const GRID_COLUMNS = '44px 220px 150px 150px 130px 190px 110px';
const HEADERS = ['', 'Name', 'Slug', 'Last Published', 'Created On', 'Post-body', 'Topic'];

// A changed cell: the new value inline, changed words in the diff color (word diff — no old → new).
function WordDiffCell({ segments }: { segments: DiffSeg[] }) {
  return (
    <Box style={{ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap' }}>
      {segments.map((s, i) => (
        <TextMono12Regular
          key={i}
          component="span"
          c={s.changed ? 'var(--modified-needs-review-stroke)' : 'var(--fg-secondary)'}
          fw={s.changed ? 475 : undefined}
        >
          {s.text}
        </TextMono12Regular>
      ))}
    </Box>
  );
}

// The status-column mark: a small filled dot colored by review state (modified rows; the real grid
// draws a subtle dot, not bars/arrows). Created/deleted rows use a + / − instead (not shown here).
function StatusDot({ review }: { review: ReviewState }) {
  if (review === 'clean') return <Box />;
  const { stroke } = modifiedTokens(review);
  return <Box style={{ width: 6, height: 6, borderRadius: '50%', background: stroke, flex: 'none' }} />;
}

function GridRow({ row, index }: { row: BlogRow; index: number }) {
  // Modified rows are NOT fully tinted — only the changed cell carries the diff bg (matches the app).
  const cell = (node: ReactNode, changed?: boolean) => (
    <Box
      style={{
        padding: '0 10px',
        display: 'flex',
        alignItems: 'center',
        borderRight: '1px solid var(--fg-divider)',
        minWidth: 0,
        height: 34,
        background: changed ? modifiedTokens(row.review).bg : 'transparent',
      }}
    >
      {node}
    </Box>
  );
  return (
    <Box
      style={{
        display: 'grid',
        gridTemplateColumns: GRID_COLUMNS,
        borderBottom: '1px solid var(--fg-divider)',
      }}
    >
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 8px',
          borderRight: '1px solid var(--fg-divider)',
          height: 34,
        }}
      >
        <StatusDot review={row.review} />
        <TextMono12Regular c="var(--fg-muted)">{index + 1}</TextMono12Regular>
      </Box>
      {cell(
        <Text13Regular c="var(--fg-primary)" truncate>
          {row.name}
        </Text13Regular>,
      )}
      {cell(
        <TextMono12Regular c="var(--fg-secondary)" truncate>
          {row.slug}
        </TextMono12Regular>,
      )}
      {cell(
        row.lastPublishedDiff ? (
          <WordDiffCell segments={row.lastPublishedDiff} />
        ) : (
          <TextMono12Regular c="var(--fg-secondary)">{row.lastPublished}</TextMono12Regular>
        ),
        !!row.lastPublishedDiff,
      )}
      {cell(<TextMono12Regular c="var(--fg-secondary)">{row.createdOn}</TextMono12Regular>)}
      {cell(
        <TextMono12Regular c="var(--fg-muted)" truncate>
          {row.postBody}
        </TextMono12Regular>,
      )}
      {cell(
        <Text13Regular c="var(--fg-secondary)" truncate>
          {row.topic}
        </Text13Regular>,
      )}
    </Box>
  );
}

function DataGrid() {
  return (
    <Stack
      gap={0}
      style={{
        flex: 1,
        minWidth: 0,
        background: 'var(--bg-base)',
        border: '0.5px solid var(--fg-divider)',
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      <GridToolbar />
      {/* column header row */}
      <Box
        style={{
          display: 'grid',
          gridTemplateColumns: GRID_COLUMNS,
          height: 28,
          borderBottom: '1px solid var(--fg-divider)',
          background: 'var(--bg-panel)',
        }}
      >
        {HEADERS.map((h, i) => (
          <Box
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              padding: '0 10px',
              borderRight: '1px solid var(--fg-divider)',
            }}
          >
            <Text12Medium c="var(--fg-muted)">{h}</Text12Medium>
          </Box>
        ))}
      </Box>
      {/* rows */}
      <Box style={{ flex: 1, overflow: 'hidden' }}>
        {ROWS.map((r, i) => (
          <GridRow key={r.slug} row={r} index={i} />
        ))}
      </Box>
      {/* status bar */}
      <Group
        gap={10}
        wrap="nowrap"
        justify="space-between"
        px={12}
        py={6}
        style={{ borderTop: '0.5px solid var(--fg-divider)' }}
      >
        <TextMono12Regular c="var(--fg-muted)">40 rows · 11 columns · Sorted by Name ↑</TextMono12Regular>
        <Group gap={12} wrap="nowrap">
          <Group gap={5} wrap="nowrap">
            <Box
              style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--modified-needs-review-stroke)' }}
            />
            <TextMono12Regular c="var(--fg-secondary)">2 need review</TextMono12Regular>
          </Group>
          <Group gap={5} wrap="nowrap">
            <Box style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--modified-approved-stroke)' }} />
            <TextMono12Regular c="var(--fg-secondary)">1 approved</TextMono12Regular>
          </Group>
          <TextMono12Regular c="var(--fg-muted)">1 / 1</TextMono12Regular>
        </Group>
      </Group>
    </Stack>
  );
}

/**
 * The main workspace screen — the desktop app's hero surface: the toolbar, the connector folder
 * tree, and the data grid for the selected folder (here a Webflow "Blog Posts" collection), with a
 * few rows mid-review showing the review-state coloring (needs-review blue, approved gray) and an
 * old → new value diff. A faithful, self-contained representation of the app as it looks today.
 */
export function WorkspaceShell() {
  return (
    <Stack
      gap={0}
      style={{
        width: 1240,
        height: 720,
        background: 'var(--bg-base)',
        border: '1px solid var(--fg-divider)',
        overflow: 'hidden',
      }}
    >
      <WorkspaceChrome />
      <Group gap={6} wrap="nowrap" align="stretch" p={6} style={{ flex: 1, minHeight: 0 }}>
        <Sidebar />
        <DataGrid />
      </Group>
    </Stack>
  );
}
