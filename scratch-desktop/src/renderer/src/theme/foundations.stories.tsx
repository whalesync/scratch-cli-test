import { Box, Group, SimpleGrid, Stack, Text } from '@mantine/core';
import type { Meta, StoryObj } from '@storybook/react-vite';

// Live design tokens, read straight from the theme's CSS variables so this preview can never drift
// from the running app.
const meta: Meta = {
  title: 'Foundations/Tokens',
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

function Swatch({ color, name, value, dark }: { color: string; name: string; value: string; dark?: boolean }) {
  return (
    <Stack gap={4}>
      <Box
        style={{
          height: 56,
          background: color,
          border: '0.5px solid var(--fg-divider)',
          color: dark ? '#fff' : undefined,
        }}
      />
      <Text fz={12} fw={475}>
        {name}
      </Text>
      <Text fz={11} c="dimmed" ff="monospace">
        {value}
      </Text>
    </Stack>
  );
}

function ReviewState({ bg, stroke, label }: { bg: string; stroke: string; label: string }) {
  return (
    <Box style={{ background: bg, borderLeft: `4px solid ${stroke}`, padding: '12px 14px', fontSize: 13 }}>{label}</Box>
  );
}

export const Colors: Story = {
  render: () => (
    <Stack gap="xl">
      <div>
        <Text fz={14} fw={500} mb="sm">
          Brand · yellow highlight
        </Text>
        <SimpleGrid cols={5} spacing="sm" maw={760}>
          <Swatch color="var(--highlight-fill)" name="Fill" value="#FEFB8A" />
          <Swatch color="var(--highlight-border)" name="Border" value="#D4C800" />
          <Swatch color="var(--highlight-fill-hover)" name="Fill hover" value="#F5F542" />
          <Swatch color="var(--highlight-border-hover)" name="Border hover" value="#B8AE00" />
          <Swatch color="#FFFF66" name="Logo yellow" value="#FFFF66" />
        </SimpleGrid>
      </div>

      <div>
        <Text fz={14} fw={500} mb="sm">
          Semantic · foreground &amp; background
        </Text>
        <SimpleGrid cols={4} spacing="sm" maw={760}>
          <Swatch color="var(--bg-panel)" name="--bg-panel" value="gray-0" />
          <Swatch color="var(--bg-selected)" name="--bg-selected" value="gray-1" />
          <Swatch color="var(--fg-primary)" name="--fg-primary" value="gray-9" dark />
          <Swatch color="var(--fg-muted)" name="--fg-muted" value="gray-7" dark />
        </SimpleGrid>
      </div>

      <div>
        <Text fz={14} fw={500} mb="sm">
          Review-state palette
        </Text>
        <SimpleGrid cols={2} spacing="sm" maw={620}>
          <ReviewState
            bg="var(--modified-needs-review-bg)"
            stroke="var(--modified-needs-review-stroke)"
            label="Modified · needs review"
          />
          <ReviewState
            bg="var(--modified-approved-bg)"
            stroke="var(--modified-approved-stroke)"
            label="Modified · approved"
          />
          <ReviewState
            bg="var(--create-needs-review-bg)"
            stroke="var(--create-needs-review-stroke)"
            label="Created · needs review"
          />
          <ReviewState
            bg="var(--create-approved-bg)"
            stroke="var(--create-approved-stroke)"
            label="Created · approved"
          />
          <ReviewState
            bg="var(--delete-needs-review-bg)"
            stroke="var(--delete-needs-review-stroke)"
            label="Deleted · needs review"
          />
          <ReviewState
            bg="var(--delete-approved-bg)"
            stroke="var(--delete-approved-stroke)"
            label="Deleted · approved"
          />
        </SimpleGrid>
      </div>
    </Stack>
  ),
};

export const Spacing: Story = {
  render: () => {
    const steps: { token: string; px: string }[] = [
      { token: '2xs', px: '4px' },
      { token: 'xs', px: '8px' },
      { token: 'sm', px: '12px' },
      { token: 'md', px: '16px' },
      { token: 'lg', px: '24px' },
      { token: 'xl', px: '32px' },
    ];
    return (
      <Stack gap="xs">
        {steps.map((s) => (
          <Group key={s.token} gap="md">
            <Text fz={12} ff="monospace" c="dimmed" w={48}>
              {s.token}
            </Text>
            <Text fz={11} ff="monospace" c="dimmed" w={40}>
              {s.px}
            </Text>
            <Box
              style={{
                width: s.px,
                height: 16,
                background: 'var(--highlight-fill)',
                border: '1px solid var(--highlight-border)',
              }}
            />
          </Group>
        ))}
      </Stack>
    );
  },
};

export const Radius: Story = {
  render: () => {
    const radii: { token: string; value: string }[] = [
      { token: 'default', value: '0px' },
      { token: 'xs', value: '4px' },
      { token: 'sm', value: '6px' },
      { token: 'md', value: '8px' },
      { token: 'lg', value: '10px' },
      { token: 'full', value: '50%' },
    ];
    return (
      <Group gap="lg" align="flex-end">
        {radii.map((r) => (
          <Stack key={r.token} gap={6} align="center">
            <Box
              style={{
                width: 72,
                height: 72,
                background: 'var(--bg-panel)',
                border: '1px solid var(--fg-divider)',
                borderRadius: r.value,
              }}
            />
            <Text fz={11} ff="monospace">
              {r.token}
            </Text>
            <Text fz={10} ff="monospace" c="dimmed">
              {r.value}
            </Text>
          </Stack>
        ))}
      </Group>
    );
  },
};
