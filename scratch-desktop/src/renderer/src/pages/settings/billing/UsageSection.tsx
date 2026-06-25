import { Text13Book, TextTitle3 } from '@/components/base/text';
import { ConnectorIcon } from '@/components/icons/ConnectorIcon';
import { getServiceName, useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { useOrganizationUsageSummary } from '@/hooks/use-organization-usage-summary';
import { Box, Group, Skeleton, Stack, Tooltip } from '@mantine/core';
import { SettingsSection } from '../SettingsSection';

// Bottom-aligned columns so labels line up even when the connector icons wrap onto multiple rows.
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
 * Usage at a glance for the current organization: workbook count, total record count, and an icon per connector
 * with at least one data folder. Org-scoped (computed server-side). Desktop counterpart of the web client's
 * billing `UsageSection`.
 */
export const UsageSection = () => {
  const { summary, isLoading } = useOrganizationUsageSummary();
  const { data: metadata } = useConnectorsMetadata();
  const connectorServices = summary?.connectorServices ?? [];

  return (
    <SettingsSection title="Usage" description="Your usage across all Scratch workspaces">
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
                  gridTemplateColumns: `repeat(${Math.min(MAX_CONNECTOR_ICONS_PER_ROW, connectorServices.length)}, max-content)`,
                  gap: 6,
                  alignItems: 'center',
                }}
              >
                {connectorServices.map((service) => (
                  <Tooltip key={service} label={getServiceName(metadata, service)}>
                    <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                      <ConnectorIcon connector={service} size={22} />
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
    </SettingsSection>
  );
};
