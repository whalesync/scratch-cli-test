'use client';

import { ButtonPrimarySolid, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import {
  Text12Regular,
  Text13Medium,
  Text13Regular,
  Text16Medium,
  Text16Regular,
  TextTitle2,
} from '@/app/components/base/text';
import { DecorativeBoxedIcon } from '@/app/components/Icons/DecorativeBoxedIcon';
import customBordersClasses from '@/app/components/theme/custom-borders.module.css';
import { useActiveWorkbook } from '@/hooks/use-active-workbook';
import { useConnectorAccounts } from '@/hooks/use-connector-account';
import { getServiceName, useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { ActionIcon, Badge, Box, Code, CopyButton, Group, Stack, Tooltip } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { Service, type WorkbookId } from '@spinner/shared-types';
import {
  ArrowRightIcon,
  CheckIcon,
  CopyIcon,
  DownloadIcon,
  LinkIcon,
  PencilIcon,
  PlusIcon,
  RocketIcon,
  UploadIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ConnectToCLIModal } from '../components/shared/ConnectToCLIModal';
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

function useServiceList() {
  const { metadata } = useConnectorsMetadata();
  return Object.values(Service).map((s) => ({
    key: s,
    name: getServiceName(metadata, s),
  }));
}

const CommandBlock = ({ command }: { command: string }) => (
  <Group
    gap="xs"
    px="sm"
    py={6}
    style={{
      backgroundColor: 'var(--bg-selected)',
      borderRadius: 'var(--mantine-radius-sm)',
      border: '1px solid var(--mantine-color-gray-3)',
    }}
  >
    <Code
      style={{
        flex: 1,
        backgroundColor: 'transparent',
        color: 'var(--fg-primary)',
        fontSize: '12px',
        fontFamily: 'var(--mantine-font-family-monospace)',
      }}
    >
      {command}
    </Code>
    <CopyButton value={command} timeout={2000}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow position="right">
          <ActionIcon color={copied ? 'blue' : 'gray'} size="xs" variant="subtle" onClick={copy}>
            {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
          </ActionIcon>
        </Tooltip>
      )}
    </CopyButton>
  </Group>
);

const GREEN = 'var(--mantine-color-green-7)';

function WorkflowGuide({ workbookId }: { workbookId: WorkbookId }) {
  const { workbook } = useActiveWorkbook();
  const [cliModalOpened, { open: openCliModal, close: closeCliModal }] = useDisclosure(false);
  const workbookName = workbook?.name || 'my-workspace';

  const steps = [
    {
      icon: DownloadIcon,
      title: 'DOWNLOAD',
      description: 'Pull your data from connected services to your local disk.',
      action: <CommandBlock command="$ scratchmd files download" />,
      secondaryAction: (
        <ButtonSecondaryOutline size="compact-xs" onClick={openCliModal}>
          Setup CLI
        </ButtonSecondaryOutline>
      ),
    },
    {
      icon: PencilIcon,
      title: 'EDIT',
      description: 'Open in Claude Code, Cursor, or any agent to make changes.',
      action: <CommandBlock command={`$ claude --add-dir "./${workbookName}"`} />,
    },
    {
      icon: UploadIcon,
      title: 'UPLOAD',
      description: 'Push your local changes back to Scratch for review.',
      action: <CommandBlock command="$ scratchmd files upload" />,
    },
    {
      icon: RocketIcon,
      title: 'REVIEW',
      description: 'Approve changes and publish them back.',
      action: (
        <Link href={`/workbook/${workbookId}/review`} style={{ textDecoration: 'none' }}>
          <Group gap={4} style={{ cursor: 'pointer' }}>
            <Text13Medium c={GREEN}>Review now</Text13Medium>
            <ArrowRightIcon size={14} color={GREEN} />
          </Group>
        </Link>
      ),
    },
  ];

  return (
    <>
      <Box h="100%" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'auto' }}>
        <Stack gap="xl" maw={640} px="xl" py="xl">
          <Stack gap="xs">
            <Text12Regular c={GREEN} style={{ textTransform: 'uppercase' }}>
              {'// THE WORKFLOW'}
            </Text12Regular>
            <TextTitle2>
              Work on your data locally. <span style={{ color: GREEN }}>Review and publish in Scratch.</span>
            </TextTitle2>
          </Stack>

          <Stack gap="sm">
            {steps.map((step) => (
              <Box key={step.title} className={customBordersClasses.cornerBorders} c="var(--fg-muted)" p="md">
                <Group gap="md" wrap="nowrap" align="center">
                  <DecorativeBoxedIcon Icon={step.icon} size="sm" c={GREEN} />
                  <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                    <Text13Medium c={GREEN} style={{ textTransform: 'uppercase' }}>
                      {step.title}
                    </Text13Medium>
                    <Text13Regular c="var(--fg-secondary)">{step.description}</Text13Regular>
                    {step.secondaryAction && <Box pt={4}>{step.secondaryAction}</Box>}
                  </Stack>
                  <Box style={{ flexShrink: 0 }}>{step.action}</Box>
                </Group>
              </Box>
            ))}
          </Stack>
        </Stack>
      </Box>
      <ConnectToCLIModal workbookId={workbookId} opened={cliModalOpened} onClose={closeCliModal} />
    </>
  );
}

/**
 * Files tab with no file selected - shows empty state
 */
export default function FilesPage() {
  const params = useParams<{ id: string }>();
  const workbookId = params.id as WorkbookId;
  const { connectorAccounts, isLoading } = useConnectorAccounts(workbookId);
  const [connectionModalOpened, { open: openConnectionModal, close: closeConnectionModal }] = useDisclosure(false);
  const services = useServiceList();

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

  return <WorkflowGuide workbookId={workbookId} />;
}
