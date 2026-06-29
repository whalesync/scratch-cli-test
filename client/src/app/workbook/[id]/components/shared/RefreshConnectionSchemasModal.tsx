'use client';

import { ButtonPrimaryLight } from '@/app/components/base/buttons';
import { Text12Regular, Text13Medium, Text13Regular } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Box, Group, Loader, Modal, ScrollArea, Stack } from '@mantine/core';
import type { RefreshConnectionSchemasResponse } from '@spinner/shared-types';
import { CircleAlertIcon, CircleCheckIcon } from 'lucide-react';

/** Refresh lifecycle while the connection-wide schema refresh runs and after it settles. */
export type RefreshConnectionSchemasStatus = 'refreshing' | 'done' | 'error';

interface RefreshConnectionSchemasModalProps {
  opened: boolean;
  onClose: () => void;
  connectionName: string;
  /** Human-readable connector type (e.g. "Airtable", "Webflow"), shown for context. */
  connectorName?: string;
  /** Total tables in the connection — shown while refreshing so the user knows the scope. */
  totalFolders: number;
  status: RefreshConnectionSchemasStatus;
  /** Present when `status === 'done'`. */
  result?: RefreshConnectionSchemasResponse;
  /** Present when `status === 'error'`. */
  errorMessage?: string;
}

/**
 * Blocking modal shown while every data folder in a connection has its schema refreshed. While the
 * request is in flight the modal cannot be dismissed (no close button, no click-outside / escape) so
 * the user waits for it to settle; once done it reports per-connection counts (and any per-folder
 * failures) and offers a Close button.
 */
export function RefreshConnectionSchemasModal({
  opened,
  onClose,
  connectionName,
  connectorName,
  totalFolders,
  status,
  result,
  errorMessage,
}: RefreshConnectionSchemasModalProps) {
  const isRefreshing = status === 'refreshing';

  const title =
    status === 'refreshing'
      ? 'Refreshing schemas'
      : status === 'done'
        ? 'Schemas refreshed'
        : 'Couldn’t refresh schemas';

  // e.g. "My Airtable · Airtable" — names both the connection and its connector type.
  const connectionLabel = connectorName ? `${connectionName} · ${connectorName}` : connectionName;

  return (
    <Modal
      opened={opened}
      // While refreshing the modal is blocking — swallow any close attempt until the request settles.
      onClose={isRefreshing ? () => {} : onClose}
      title={title}
      centered
      size="md"
      closeOnClickOutside={!isRefreshing}
      closeOnEscape={!isRefreshing}
      withCloseButton={!isRefreshing}
    >
      <Stack gap="md">
        {/* Connection + connector context, shown in every state. */}
        <Text12Regular c="var(--fg-secondary)">{connectionLabel}</Text12Regular>

        {status === 'refreshing' && (
          <Group gap="sm" wrap="nowrap">
            <Loader size="sm" />
            <Text13Regular>
              Refreshing {totalFolders} {totalFolders === 1 ? 'schema' : 'schemas'}…
            </Text13Regular>
          </Group>
        )}

        {status === 'done' && result && (
          <Stack gap="sm">
            <Group gap="sm" wrap="nowrap">
              <StyledLucideIcon
                Icon={result.failedCount > 0 ? CircleAlertIcon : CircleCheckIcon}
                size="md"
                c={result.failedCount > 0 ? 'var(--mantine-color-yellow-6)' : 'var(--mantine-color-green-6)'}
              />
              <Text13Medium>
                Refreshed {result.refreshedCount} of {result.refreshedCount + result.failedCount}{' '}
                {result.refreshedCount + result.failedCount === 1 ? 'schema' : 'schemas'}
                {result.failedCount > 0 ? `, ${result.failedCount} failed` : ''}.
              </Text13Medium>
            </Group>

            {/* Every table and whether its schema refreshed or failed. */}
            {result.results.length > 0 && (
              <ScrollArea.Autosize mah={280}>
                <Stack gap="xs">
                  {result.results.map((folder) => (
                    <Group key={folder.dataFolderId} gap="xs" wrap="nowrap" align="flex-start">
                      <StyledLucideIcon
                        Icon={folder.status === 'refreshed' ? CircleCheckIcon : CircleAlertIcon}
                        size="sm"
                        c={
                          folder.status === 'refreshed'
                            ? 'var(--mantine-color-green-6)'
                            : 'var(--mantine-color-yellow-6)'
                        }
                      />
                      <Box style={{ minWidth: 0 }}>
                        <Text13Regular>{folder.folderName}</Text13Regular>
                        {folder.status === 'failed' && folder.error && (
                          <Text12Regular c="var(--fg-muted)">{folder.error}</Text12Regular>
                        )}
                      </Box>
                    </Group>
                  ))}
                </Stack>
              </ScrollArea.Autosize>
            )}
          </Stack>
        )}

        {status === 'error' && (
          <Group gap="sm" wrap="nowrap" align="flex-start">
            <StyledLucideIcon Icon={CircleAlertIcon} size="md" c="var(--mantine-color-red-6)" />
            <Text13Regular c="var(--mantine-color-red-6)">
              {errorMessage ?? 'An unexpected error occurred.'}
            </Text13Regular>
          </Group>
        )}

        {!isRefreshing && (
          <Group justify="flex-end" mt="md">
            <ButtonPrimaryLight onClick={onClose}>Close</ButtonPrimaryLight>
          </Group>
        )}
      </Stack>
    </Modal>
  );
}
