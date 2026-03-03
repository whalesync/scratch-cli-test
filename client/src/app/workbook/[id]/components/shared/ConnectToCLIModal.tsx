'use client';

import { ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text13Regular, Text16Medium } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { ActionIcon, Anchor, Box, Code, CopyButton, Group, Modal, Stack, Tooltip } from '@mantine/core';
import { CheckIcon, CopyIcon, ExternalLinkIcon, TerminalIcon } from 'lucide-react';
import Link from 'next/link';

interface ConnectToCLIModalProps {
  workbookId: string;
  opened: boolean;
  onClose: () => void;
}

const StepNumber = ({ number }: { number: number }) => (
  <Box
    style={{
      width: 32,
      height: 32,
      borderRadius: '50%',
      backgroundColor: 'var(--mantine-color-blue-6)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    }}
  >
    <Text16Medium c="white">{number}</Text16Medium>
  </Box>
);

const CommandBlock = ({ command }: { command: string }) => (
  <Group
    gap="xs"
    p="md"
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
        fontSize: 'var(--mantine-font-size-sm)',
        fontFamily: 'var(--mantine-font-family-monospace)',
      }}
    >
      {command}
    </Code>
    <CopyButton value={command} timeout={2000}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow position="right">
          <ActionIcon color={copied ? 'blue' : 'gray'} size="sm" variant="subtle" onClick={copy}>
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
          </ActionIcon>
        </Tooltip>
      )}
    </CopyButton>
  </Group>
);

export function ConnectToCLIModal({ workbookId, opened, onClose }: ConnectToCLIModalProps) {
  const initCommand = `scratchmd workbooks init ${workbookId}`;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <StyledLucideIcon Icon={TerminalIcon} size={18} />
          <Text16Medium>Connect to CLI</Text16Medium>
        </Group>
      }
      size="lg"
      centered
      padding="xl"
    >
      <Stack gap="xl" py="md">
        <Text13Regular c="dimmed">
          Work with your data locally using the command-line tool, with built-in support for AI coding agents like
          Claude Code and OpenAI Codex.
        </Text13Regular>

        <Group gap="md" align="flex-start" wrap="nowrap">
          <StepNumber number={1} />
          <Stack gap="xs" style={{ flex: 1 }}>
            <Text16Medium>Install the CLI tool</Text16Medium>
            <Text13Regular c="dimmed">
              Follow the installation instructions to set up the Scratch CLI on your computer:
            </Text13Regular>
            <Box pt="xs">
              <Anchor
                component={Link}
                href="https://github.com/whalesync/scratch-cli?tab=readme-ov-file#installation"
                target="_blank"
                size="sm"
              >
                <Group gap={4}>
                  View installation guide
                  <ExternalLinkIcon size={14} />
                </Group>
              </Anchor>
            </Box>
          </Stack>
        </Group>

        <Group gap="md" align="flex-start" wrap="nowrap">
          <StepNumber number={2} />
          <Stack gap="xs" style={{ flex: 1 }}>
            <Text16Medium>Log in to your account</Text16Medium>
            <Text13Regular c="dimmed">Authenticate the CLI with your Scratch account.</Text13Regular>
            <Box pt="xs">
              <CommandBlock command="scratchmd auth login" />
            </Box>
          </Stack>
        </Group>

        <Group gap="md" align="flex-start" wrap="nowrap">
          <StepNumber number={3} />
          <Stack gap="xs" style={{ flex: 1 }}>
            <Text16Medium>Clone this workbook to your computer</Text16Medium>
            <Text13Regular c="dimmed">
              Run this command in your terminal to download a local copy of this workbook.
            </Text13Regular>
            <Box pt="xs">
              <CommandBlock command={initCommand} />
            </Box>
          </Stack>
        </Group>
      </Stack>

      <Group justify="flex-end" pt="md">
        <ButtonSecondaryOutline onClick={onClose}>Close</ButtonSecondaryOutline>
      </Group>
    </Modal>
  );
}
