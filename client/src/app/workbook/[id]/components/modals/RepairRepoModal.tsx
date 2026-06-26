'use client';

import { ConfirmDialog, useConfirmDialog } from '@/app/components/modals/ConfirmDialog';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { Alert, Badge, Button, Code, Group, List, Loader, Modal, ScrollArea, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { GitFsckResponse, GitRepairResponse } from '@spinner/shared-types';
import { useCallback, useEffect, useState } from 'react';

interface RepairRepoModalProps {
  opened: boolean;
  onClose: () => void;
  connectorAccountId: string;
  connectionName: string;
}

/**
 * Admin-only "Diagnose / Repair git repo" tool. Runs a read-only `git fsck`
 * against the connection's server-side bare repo, and — when the corruption is
 * confined to the working (`dirty`) branch — offers a one-click repair that
 * resets `dirty` to `main`. Published (`main`) data is never touched; the only
 * loss is the connection's unpublished edits. When `main` itself is corrupt the
 * repair is refused and manual recovery is required. (DEV-10574)
 */
export function RepairRepoModal({ opened, onClose, connectorAccountId, connectionName }: RepairRepoModalProps) {
  const [report, setReport] = useState<GitFsckResponse | null>(null);
  const [lastRepair, setLastRepair] = useState<GitRepairResponse | null>(null);
  const [isDiagnosing, setIsDiagnosing] = useState(false);
  const [isRepairing, setIsRepairing] = useState(false);
  const { open: openConfirm, dialogProps: confirmDialogProps } = useConfirmDialog();

  const diagnose = useCallback(async () => {
    setIsDiagnosing(true);
    try {
      const result = await scratchApiClient.devTools.fsckConnectionRepo(connectorAccountId);
      setReport(result);
    } catch {
      notifications.show({ title: 'Error', message: 'Failed to diagnose connection repo', color: 'red' });
    } finally {
      setIsDiagnosing(false);
    }
  }, [connectorAccountId]);

  // Diagnose automatically when the modal opens; clear prior state.
  useEffect(() => {
    if (!opened) return;
    setReport(null);
    setLastRepair(null);
    void diagnose();
  }, [opened, diagnose]);

  const runRepair = async () => {
    setIsRepairing(true);
    try {
      const result = await scratchApiClient.devTools.repairConnectionRepo(connectorAccountId);
      setLastRepair(result);
      setReport(result.after ?? result.before);
      if (result.status === 'repaired') {
        notifications.show({ title: 'Repaired', message: `Repaired git repo for ${connectionName}`, color: 'green' });
      } else if (result.status === 'already_clean') {
        notifications.show({ title: 'Already healthy', message: 'No changes were needed', color: 'blue' });
      } else {
        notifications.show({
          title: 'Repair refused',
          message: 'main is corrupt — manual recovery is required',
          color: 'red',
        });
      }
    } catch {
      notifications.show({ title: 'Error', message: 'Failed to repair connection repo', color: 'red' });
    } finally {
      setIsRepairing(false);
    }
  };

  const confirmRepair = () => {
    openConfirm({
      title: 'Repair git repo',
      message:
        `This resets this connection's working branch (dirty) to the published branch (main), ` +
        `discarding any unpublished edits for "${connectionName}". Published data is not affected. Continue?`,
      confirmLabel: 'Repair',
      variant: 'danger',
      onConfirm: runRepair,
    });
  };

  const isHealthy = report !== null && report.fsckClean && report.refsAllWalkable;
  const mainCorrupt = report !== null && !report.mainWalkable;
  const canRepair = report !== null && !isHealthy && report.mainWalkable;

  return (
    <Modal opened={opened} onClose={onClose} title={`Diagnose / Repair Repo — ${connectionName}`} size="lg" centered>
      <Stack>
        {isDiagnosing && report === null ? (
          <Group gap="xs">
            <Loader size="sm" />
            <Text size="sm" c="dimmed">
              Running git fsck…
            </Text>
          </Group>
        ) : report === null ? (
          <Text size="sm" c="dimmed">
            Diagnosis unavailable.
          </Text>
        ) : (
          <>
            {isHealthy && (
              <Alert color="green" title="Repo is healthy">
                All refs walk cleanly — a fresh clone / re-download will succeed.
              </Alert>
            )}
            {!isHealthy && mainCorrupt && (
              <Alert color="red" title="main branch is corrupt">
                Published data is affected. This needs manual object recovery (break-glass) rather than a dirty reset —
                repair is disabled.
              </Alert>
            )}
            {!isHealthy && !mainCorrupt && (
              <Alert color="yellow" title="Working (dirty) branch is corrupt">
                Published data (main) is intact. Repair resets the working branch to main, discarding the unpublished
                edits for this connection, and makes clone / re-download succeed again.
              </Alert>
            )}

            <Group gap="xs">
              <Badge color={report.fsckClean ? 'green' : 'red'} variant="light">
                fsck {report.fsckClean ? 'clean' : 'errors'}
              </Badge>
              <Badge color={report.refsAllWalkable ? 'green' : 'red'} variant="light">
                {report.refsAllWalkable ? 'all refs walkable' : `${report.corruptRefs.length} corrupt ref(s)`}
              </Badge>
              <Badge color={report.mainWalkable ? 'green' : 'red'} variant="light">
                main {report.mainWalkable ? 'ok' : 'corrupt'}
              </Badge>
              <Badge color={report.dirtyWalkable ? 'green' : 'red'} variant="light">
                dirty {report.dirtyWalkable ? 'ok' : 'corrupt'}
              </Badge>
            </Group>

            {report.refs.length > 0 && (
              <Stack gap={2}>
                <Text size="xs" fw={600} c="dimmed">
                  Refs
                </Text>
                {report.refs.map((r) => (
                  <Group key={r.refName} gap="xs" wrap="nowrap">
                    <Badge size="xs" color={r.walkable ? 'green' : 'red'} variant="light">
                      {r.walkable ? 'ok' : 'corrupt'}
                    </Badge>
                    <Text size="xs" ff="monospace">
                      {r.refName}
                    </Text>
                  </Group>
                ))}
              </Stack>
            )}

            {report.missingObjects.length > 0 && (
              <Text size="xs" c="dimmed">
                Missing objects:{' '}
                <Text span ff="monospace">
                  {report.missingObjects.join(', ')}
                </Text>
              </Text>
            )}
            {report.unreadableObjects.length > 0 && (
              <Text size="xs" c="dimmed">
                Unreadable objects:{' '}
                <Text span ff="monospace">
                  {report.unreadableObjects.join(', ')}
                </Text>
              </Text>
            )}

            {lastRepair && lastRepair.actions.length > 0 && (
              <Stack gap={2}>
                <Text size="xs" fw={600} c="dimmed">
                  Repair actions
                </Text>
                <List size="xs" spacing={2}>
                  {lastRepair.actions.map((a, i) => (
                    <List.Item key={i}>{a}</List.Item>
                  ))}
                </List>
              </Stack>
            )}

            {report.rawFsck.trim().length > 0 && (
              <ScrollArea.Autosize mah={160}>
                <Code block fz="xs">
                  {report.rawFsck}
                </Code>
              </ScrollArea.Autosize>
            )}
          </>
        )}

        <Group justify="space-between" mt="sm">
          <Button variant="default" onClick={() => void diagnose()} loading={isDiagnosing} disabled={isRepairing}>
            Re-run diagnosis
          </Button>
          <Group>
            <Button variant="default" onClick={onClose} disabled={isRepairing}>
              Close
            </Button>
            <Button color="red" onClick={confirmRepair} loading={isRepairing} disabled={!canRepair}>
              Repair (reset dirty → main)
            </Button>
          </Group>
        </Group>
      </Stack>
      <ConfirmDialog {...confirmDialogProps} />
    </Modal>
  );
}
