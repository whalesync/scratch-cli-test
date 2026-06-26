// Faithful reproduction of the desktop app's RecordDetailView — the single-record inspector that
// overlays the grid: a record navigator on the left and a FIELD / CURRENT / NEW field table on the
// right, with changed fields diffed against the published value. Self-contained; no IPC. From the
// real component + a live screenshot (DEV-10592).
import { Box, Group, Stack } from '@mantine/core';
import { Braces, ChevronDown, ChevronUp, CircleAlert, X } from 'lucide-react';
import { ButtonSecondaryGhost } from '../../buttons';
import { Text12Medium, Text12Regular, TextMono12Regular, TextMono9Regular, TextTitle3 } from '../../text';

type RecStatus = 'clean' | 'needs-review' | 'approved';
const NAV_RECORDS: { name: string; status: RecStatus; selected?: boolean }[] = [
  { name: 'Building a Balanced Cocktail: Spirit, S…', status: 'needs-review' },
  { name: 'How to Brew the Perfect Cup of Green Tea', status: 'approved', selected: true },
  { name: 'Brewing Kombucha: Your First SCOBY', status: 'approved' },
  { name: 'Building Your First Cheese Board', status: 'clean' },
  { name: 'Choosing the Right Drink Size for Your…', status: 'clean' },
  { name: 'Choosing Wood for Your Smoker', status: 'clean' },
  { name: "Choosing Your First Chef's Knife", status: 'clean' },
  { name: 'How to Cook Pasta Al Dente Every…', status: 'clean' },
  { name: 'Direct vs. Indirect Heat on the Grill', status: 'clean' },
  { name: 'Fresh vs. Dried Pasta: When to Use…', status: 'clean' },
  { name: 'The Four Knife Cuts Every Cook…', status: 'clean' },
  { name: 'Getting Started with Sauerkraut', status: 'clean' },
  { name: 'How Long Should You Ferment?…', status: 'clean' },
];

function statusStroke(status: RecStatus): string {
  return status === 'needs-review' ? 'var(--modified-needs-review-stroke)' : 'var(--modified-approved-stroke)';
}

interface FieldRow {
  label: string;
  key: string;
  hint?: string;
  current: string;
  /** New value when changed; the trailing added text renders in the diff color. */
  newAdded?: string;
  error?: boolean;
}
const FIELDS: FieldRow[] = [
  { label: 'Name', key: 'fieldData.name', current: 'How to Brew the Perfect Cup of Green Tea' },
  { label: 'Id', key: 'id', hint: 'Unique item identifier (read-only)', current: '6a39384e5074c66bafa63aa9' },
  { label: 'Slug', key: 'fieldData.slug', current: 'brew-perfect-green-tea' },
  {
    label: 'Last Published',
    key: 'lastPublished',
    hint: 'When the item was last published (read-only)',
    current: '2026-06-26T15:48:01.912Z',
    newAdded: ' — revised',
    error: true,
  },
  { label: 'Last Updated', key: 'lastUpdated', current: 'Jun 26, 2026, 11:47:41 AM' },
  { label: 'Created On', key: 'createdOn', current: 'Jun 22, 2026, 9:27:42 AM' },
];

const FIELD_TEMPLATE = '300px 1fr 1fr';

function Navigator() {
  return (
    <Stack
      gap={0}
      style={{ width: 240, flexShrink: 0, background: 'var(--bg-panel)', borderRight: '0.5px solid var(--fg-divider)' }}
    >
      <Group
        gap={6}
        wrap="nowrap"
        justify="space-between"
        px={12}
        py={6}
        style={{ borderBottom: '0.5px solid var(--fg-divider)' }}
      >
        <Text12Regular c="var(--fg-muted)">2 of 40</Text12Regular>
        <Group gap={2} wrap="nowrap">
          <ChevronUp size={14} color="var(--fg-muted)" />
          <ChevronDown size={14} color="var(--fg-muted)" />
        </Group>
      </Group>
      <Box style={{ flex: 1, overflow: 'hidden' }}>
        {NAV_RECORDS.map((r) => (
          <Group
            key={r.name}
            gap={8}
            wrap="nowrap"
            px={12}
            py={6}
            style={{ background: r.selected ? 'var(--highlight-fill)' : undefined }}
          >
            <Box style={{ width: 8, flex: 'none', display: 'flex', justifyContent: 'center' }}>
              {r.status !== 'clean' && (
                <Box style={{ width: 7, height: 7, borderRadius: '50%', background: statusStroke(r.status) }} />
              )}
            </Box>
            <Text12Regular c={r.selected ? 'var(--fg-primary)' : 'var(--fg-secondary)'} truncate>
              {r.name}
            </Text12Regular>
          </Group>
        ))}
      </Box>
    </Stack>
  );
}

function FieldValueNew({ field }: { field: FieldRow }) {
  if (!field.newAdded) return <Text12Regular c="var(--fg-muted)">(unchanged)</Text12Regular>;
  return (
    <Box>
      <TextMono12Regular component="span" c="var(--fg-secondary)">
        {field.current}
      </TextMono12Regular>
      <TextMono12Regular component="span" c="var(--modified-needs-review-stroke)" fw={475}>
        {field.newAdded}
      </TextMono12Regular>
    </Box>
  );
}

export function RecordDetailView() {
  return (
    <Stack
      gap={0}
      style={{
        width: 1240,
        maxWidth: '100%',
        height: 640,
        background: 'var(--bg-base)',
        border: '0.5px solid var(--fg-divider)',
        borderRadius: 4,
        overflow: 'hidden',
      }}
    >
      <Group gap={0} wrap="nowrap" align="stretch" style={{ flex: 1, minHeight: 0 }}>
        <Navigator />
        <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
          {/* detail header */}
          <Group
            gap={10}
            wrap="nowrap"
            justify="space-between"
            px={16}
            py={10}
            style={{ borderBottom: '0.5px solid var(--fg-divider)' }}
          >
            <TextTitle3 style={{ minWidth: 0 }}>How to Brew the Perfect Cup of Green Tea</TextTitle3>
            <Group gap={10} wrap="nowrap" align="center">
              <Text12Regular c="var(--fg-muted)">2 fields approved</Text12Regular>
              <ButtonSecondaryGhost size="xs">Publish</ButtonSecondaryGhost>
              <Braces size={15} color="var(--fg-muted)" />
              <X size={16} color="var(--fg-muted)" />
            </Group>
          </Group>
          {/* field table header */}
          <Box
            style={{
              display: 'grid',
              gridTemplateColumns: FIELD_TEMPLATE,
              borderBottom: '0.5px solid var(--fg-divider)',
              background: 'var(--bg-panel)',
            }}
          >
            {['Field', 'Current', 'New'].map((h, i) => (
              <Box key={i} px={16} py={8} style={{ borderRight: i < 2 ? '0.5px solid var(--fg-divider)' : 'none' }}>
                <TextMono9Regular c="var(--fg-muted)" tt="uppercase" style={{ letterSpacing: '0.06em' }}>
                  {h}
                </TextMono9Regular>
              </Box>
            ))}
          </Box>
          {/* field rows */}
          <Box style={{ flex: 1, overflow: 'auto' }}>
            {FIELDS.map((f) => (
              <Box
                key={f.key}
                style={{
                  display: 'grid',
                  gridTemplateColumns: FIELD_TEMPLATE,
                  borderBottom: '0.5px solid var(--fg-divider)',
                }}
              >
                <Box px={16} py={11} style={{ borderRight: '0.5px solid var(--fg-divider)' }}>
                  <Group gap={6} wrap="nowrap">
                    {f.error && <CircleAlert size={14} color="var(--mantine-color-red-6)" style={{ flex: 'none' }} />}
                    <Text12Medium c="var(--fg-primary)">{f.label}</Text12Medium>
                  </Group>
                  <TextMono9Regular c="var(--fg-muted)">{f.key}</TextMono9Regular>
                  {f.hint && (
                    <Text12Regular c="var(--fg-muted)" style={{ marginTop: 2 }}>
                      {f.hint}
                    </Text12Regular>
                  )}
                </Box>
                <Box px={16} py={11} style={{ borderRight: '0.5px solid var(--fg-divider)', minWidth: 0 }}>
                  <TextMono12Regular c="var(--fg-secondary)" truncate>
                    {f.current}
                  </TextMono12Regular>
                </Box>
                <Box
                  px={16}
                  py={11}
                  style={{ minWidth: 0, background: f.newAdded ? 'var(--modified-approved-bg)' : 'transparent' }}
                >
                  <FieldValueNew field={f} />
                </Box>
              </Box>
            ))}
          </Box>
        </Stack>
      </Group>
      {/* status bar */}
      <Group
        gap={10}
        wrap="nowrap"
        justify="space-between"
        px={14}
        py={6}
        style={{ borderTop: '0.5px solid var(--fg-divider)' }}
      >
        <TextMono12Regular c="var(--fg-muted)">40 rows · 11 columns</TextMono12Regular>
        <Group gap={5} wrap="nowrap">
          <Box style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--modified-approved-stroke)' }} />
          <TextMono12Regular c="var(--fg-secondary)">4 modified</TextMono12Regular>
        </Group>
      </Group>
    </Stack>
  );
}
