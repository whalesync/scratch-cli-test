'use client';

import { ButtonPrimarySolid } from '@/app/components/base/buttons';
import { Text13Regular, Text16Medium, Text16Regular } from '@/app/components/base/text';
import { DecorativeBoxedIcon } from '@/app/components/Icons/DecorativeBoxedIcon';
import { useConnectorAccounts } from '@/hooks/use-connector-account';
import { ServiceNamingConventions } from '@/service-naming-conventions';
import { Badge, Box, Stack } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Service, type WorkbookId } from '@spinner/shared-types';
import { LinkIcon, PlusIcon } from 'lucide-react';
import { useParams } from 'next/navigation';
import { CreateConnectionModal } from '../components/shared/CreateConnectionModal';

const CHIP_COLORS = [
  'var(--mantine-color-green-5)',
  'var(--mantine-color-blue-5)',
  'var(--mantine-color-orange-5)',
  'var(--mantine-color-violet-5)',
  'var(--mantine-color-cyan-5)',
  'var(--mantine-color-pink-5)',
  'var(--mantine-color-yellow-5)',
  'var(--mantine-color-teal-5)',
  'var(--mantine-color-indigo-5)',
  'var(--mantine-color-grape-5)',
  'var(--mantine-color-lime-5)',
  'var(--mantine-color-red-5)',
];

const services = Object.values(Service).map((s) => ({
  key: s,
  name: ServiceNamingConventions[s].service,
}));

/**
 * Files tab with no file selected - shows empty state
 */
export default function FilesPage() {
  const params = useParams<{ id: string }>();
  const workbookId = params.id as WorkbookId;
  const { connectorAccounts, isLoading } = useConnectorAccounts(workbookId);
  const [connectionModalOpened, { open: openConnectionModal, close: closeConnectionModal }] = useDisclosure(false);

  const hasConnections = !isLoading && connectorAccounts && connectorAccounts.length > 0;

  if (!isLoading && !hasConnections) {
    return (
      <>
        <Box h="100%" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Stack align="center" gap="lg" maw={420}>
            <DecorativeBoxedIcon Icon={LinkIcon} size="lg" c="var(--fg-secondary)" />
            <Stack align="center" gap={4}>
              <Text16Regular c="var(--fg-secondary)">
                Connect your first{' '}
                <Text16Medium span c="var(--mantine-color-green-5)">
                  data source.
                </Text16Medium>
              </Text16Regular>
              <Text13Regular c="dimmed" ta="center">
                Pull in live data. Your files appear here.
              </Text13Regular>
            </Stack>
            <ButtonPrimarySolid size="md" leftSection={<PlusIcon size={16} />} onClick={openConnectionModal}>
              Connect service
            </ButtonPrimarySolid>
            <Box
              w={460}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                justifyContent: 'center',
                gap: 8,
              }}
            >
              {services.map((s, i) => (
                <Badge
                  key={s.key}
                  variant="dot"
                  color={CHIP_COLORS[i % CHIP_COLORS.length]}
                  size="lg"
                  radius="xl"
                  styles={{
                    root: { textTransform: 'none', fontWeight: 400, flex: '1 0 auto', justifyContent: 'center' },
                  }}
                >
                  {s.name}
                </Badge>
              ))}
            </Box>
          </Stack>
        </Box>
        <CreateConnectionModal
          opened={connectionModalOpened}
          onClose={closeConnectionModal}
          workbookId={workbookId}
          returnUrl={`/workbook/${workbookId}/files`}
        />
      </>
    );
  }

  return (
    <Box h="100%" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Stack align="center" gap="xs">
        <Text13Regular c="dimmed">Select a file from the sidebar to view its contents</Text13Regular>
      </Stack>
    </Box>
  );
}
