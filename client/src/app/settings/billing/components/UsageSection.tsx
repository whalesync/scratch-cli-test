import { Text13Book, TextTitle3 } from '@/app/components/base/text';
import { ConfigSection } from '@/app/components/ConfigSection';
import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { getServiceName, useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { useOrganizationUsageSummary } from '@/hooks/use-organization-usage-summary';
import { Box, Divider, Group, Skeleton, Stack, Tooltip } from '@mantine/core';

// The usage columns are bottom-aligned (see the Group below) so their labels line up even when the
// connector icons wrap onto multiple rows. VALUE_ROW_HEIGHT keeps the value row a consistent height
// (the connector row uses it as a min-height so it can grow as icons wrap); LABEL_GAP is the gap
// between each value and its centered label.
const VALUE_ROW_HEIGHT = 24;
const LABEL_GAP = 6;
const MAX_CONNECTOR_ICONS_PER_ROW = 8;

function UsageStat({ label, value, isLoading }: { label: string; value: number | undefined; isLoading: boolean }) {
  return (
    <Stack gap={LABEL_GAP} align="center">
      <Group h={VALUE_ROW_HEIGHT} align="center">
        {isLoading || value === undefined ? (
          <Skeleton height={23} width={48} />
        ) : (
          <TextTitle3>{value.toLocaleString()}</TextTitle3>
        )}
      </Group>
      <Text13Book c="dimmed">{label}</Text13Book>
    </Stack>
  );
}

/**
 * Usage at a glance for the current organization: how many workbooks it owns, the total record
 * count across all of them, and an icon per connector that has at least one data folder. All three
 * are org-scoped (computed server-side) so they describe the same set. Used on the billing page so
 * the value is visible before record-count-based pricing lands (DEV-10536).
 */
export const UsageSection = () => {
  const { summary, isLoading } = useOrganizationUsageSummary();
  const { metadata } = useConnectorsMetadata();
  const connectorServices = summary?.connectorServices ?? [];
  const runCounts = summary?.monthlyRunCounts;

  return (
    <ConfigSection title="Usage" description="Your usage across all Scratch workspaces">
      <Group px="12px" py="10px" gap="48px" align="flex-end">
        <UsageStat label="Workbooks" value={summary?.workbookCount} isLoading={isLoading} />
        <UsageStat label="Records" value={summary?.recordCount} isLoading={isLoading} />
        <Stack gap={LABEL_GAP} align="center">
          <Box style={{ minHeight: VALUE_ROW_HEIGHT, display: 'flex', alignItems: 'center' }}>
            {isLoading ? (
              <Skeleton height={22} width={22} circle />
            ) : connectorServices.length > 0 ? (
              <Box
                style={{
                  display: 'grid',
                  // Cap at 6 columns so the icons wrap onto a new row after 6; use the smaller count
                  // when there are fewer so there's no trailing empty-column gap.
                  gridTemplateColumns: `repeat(${Math.min(MAX_CONNECTOR_ICONS_PER_ROW, connectorServices.length)}, max-content)`,
                  gap: 6,
                  alignItems: 'center',
                }}
              >
                {connectorServices.map((service) => (
                  <Tooltip key={service} label={getServiceName(metadata, service)}>
                    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                      <ConnectorIcon connector={service} size={22} withBorder />
                    </span>
                  </Tooltip>
                ))}
              </Box>
            ) : (
              <Text13Book c="dimmed">No connectors yet</Text13Book>
            )}
          </Box>
          <Text13Book c="dimmed">Connectors Used</Text13Book>
        </Stack>
      </Group>
      <Divider c="var(--mantine-color-gray-3)" />
      <Stack px="12px" py="10px" gap={8}>
        <Text13Book c="dimmed">Runs this month</Text13Book>
        <Group gap="48px" align="flex-end">
          <UsageStat label="Total" value={runCounts?.total} isLoading={isLoading} />
          <UsageStat label="Pulls" value={runCounts?.pull} isLoading={isLoading} />
          <UsageStat label="Publishes" value={runCounts?.publish} isLoading={isLoading} />
          <UsageStat label="Syncs" value={runCounts?.sync} isLoading={isLoading} />
          <UsageStat label="Routines" value={runCounts?.routine} isLoading={isLoading} />
        </Group>
      </Stack>
    </ConfigSection>
  );
};
