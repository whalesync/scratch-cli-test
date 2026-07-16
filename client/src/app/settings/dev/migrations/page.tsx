'use client';

import MainContent from '@/app/components/layouts/MainContent';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { formatNumber } from '@/utils/helpers';
import { Alert, Button, Card, Checkbox, Group, NumberInput, Select, Stack, Text, Textarea, Title } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { MigrationDescriptor, MigrationResult } from '@spinner/shared-types';
import { AlertCircle, CheckCircle2, Database, DatabaseIcon, Info } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

export default function MigrationsDevPage() {
  const [availableMigrations, setAvailableMigrations] = useState<MigrationDescriptor[]>([]);
  const [isLoadingMigrations, setIsLoadingMigrations] = useState(true);
  const [selectedMigration, setSelectedMigration] = useState<string | null>(null);
  const [qty, setQty] = useState<number | string>('');
  const [ids, setIds] = useState<string>('');
  const [dryRun, setDryRun] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [lastResult, setLastResult] = useState<MigrationResult | null>(null);

  useEffect(() => {
    loadAvailableMigrations();
  }, []);

  const selectedDescriptor = useMemo(
    () => availableMigrations.find((m) => m.name === selectedMigration) ?? null,
    [availableMigrations, selectedMigration],
  );
  const selectedDescription = selectedDescriptor?.description;
  const dryRunSupported = selectedDescriptor?.supportsDryRun ?? false;

  const loadAvailableMigrations = async () => {
    try {
      const response = await scratchApiClient.codeMigrations.getAvailableMigrations();
      setAvailableMigrations(response.migrations);
    } catch (error) {
      console.error('Failed to load migrations:', error);
      notifications.show({
        title: 'Error',
        message: 'Failed to load available migrations',
        color: 'red',
      });
    } finally {
      setIsLoadingMigrations(false);
    }
  };

  const handleRunMigration = async () => {
    if (!selectedMigration) {
      notifications.show({
        title: 'Error',
        message: 'Please select a migration',
        color: 'red',
      });
      return;
    }

    // Parse IDs if provided
    const idsArray = ids
      .trim()
      .split(/[\s,]+/)
      .filter((id) => id.length > 0);

    // Validate that either qty or ids is provided
    if (!qty && idsArray.length === 0) {
      notifications.show({
        title: 'Error',
        message: 'Please provide either quantity or IDs',
        color: 'red',
      });
      return;
    }

    if (qty && idsArray.length > 0) {
      notifications.show({
        title: 'Error',
        message: 'Please provide either quantity OR IDs, not both',
        color: 'red',
      });
      return;
    }

    setIsRunning(true);

    try {
      const isDryRun = dryRunSupported && dryRun;
      const result = await scratchApiClient.codeMigrations.runMigration({
        migration: selectedMigration,
        qty: qty ? Number(qty) : undefined,
        ids: idsArray.length > 0 ? idsArray : undefined,
        dryRun: isDryRun ? true : undefined,
      });

      setLastResult(result);

      notifications.show({
        title: result.dryRun ? 'Dry run complete' : 'Migration completed',
        message: result.dryRun
          ? `Would migrate ${formatNumber(result.migratedIds.length)} items; ${formatNumber(result.remainingCount)} would remain. No changes were written.`
          : `Migrated ${formatNumber(result.migratedIds.length)} items. ${formatNumber(result.remainingCount)} remaining.`,
        color: 'green',
      });

      // Reset only the targeting inputs. Keep the selected migration and the
      // dry-run choice so the common "dry-run, eyeball it, then run for real"
      // flow is just un-checking the box and clicking again.
      setQty('');
      setIds('');
    } catch (error) {
      console.error('Migration error:', error);
      notifications.show({
        title: 'Migration failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        color: 'red',
      });
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <MainContent>
      <MainContent.BasicHeader title="Code Migrations" Icon={DatabaseIcon} />
      <MainContent.Body>
        <Stack gap="lg" maw={900}>
          <Alert icon={<AlertCircle size={16} />} color="blue">
            <Text size="sm">
              Run manual, code-based, data migrations to update existing user data to new formats and schemas. These
              updates are more complicated than a simple Prisma migration and often require JSON restructuring or other
              services.
            </Text>
          </Alert>

          <Card shadow="sm" padding="lg" radius="md" withBorder>
            <Stack gap="md">
              <Group gap="sm">
                <Database size={20} />
                <Title order={3}>Run Migration</Title>
              </Group>

              <Select
                label="Migration"
                placeholder="Select a migration to run"
                data={availableMigrations.map((m) => ({ value: m.name, label: m.name }))}
                value={selectedMigration}
                onChange={setSelectedMigration}
                disabled={isLoadingMigrations}
              />

              {selectedDescription && (
                <Alert icon={<Info size={16} />} color="gray" variant="light">
                  <Text size="sm">{selectedDescription}</Text>
                </Alert>
              )}

              <NumberInput
                label="Quantity"
                description="Number of items to migrate (leave empty if using IDs)"
                placeholder="5"
                value={qty}
                onChange={setQty}
                min={1}
                max={1000}
                disabled={isRunning}
              />

              <Textarea
                label="IDs"
                description="Comma or space-separated list of IDs to migrate (leave empty if using quantity)"
                placeholder="wkb_abc123, wkb_def456"
                value={ids}
                onChange={(e) => setIds(e.currentTarget.value)}
                disabled={isRunning}
                rows={3}
              />

              <Checkbox
                label="Dry run"
                description={
                  dryRunSupported
                    ? 'Report the would-be changes without writing anything. Recommended before a real run.'
                    : selectedMigration
                      ? 'This migration does not support dry-run — it always performs a real run.'
                      : 'Select a migration that supports dry-run to enable this.'
                }
                checked={dryRunSupported && dryRun}
                onChange={(e) => setDryRun(e.currentTarget.checked)}
                disabled={!dryRunSupported || isRunning}
              />

              <Group>
                <Button
                  onClick={handleRunMigration}
                  loading={isRunning}
                  disabled={!selectedMigration}
                  leftSection={<Database size={16} />}
                >
                  {dryRunSupported && dryRun ? 'Run dry run' : 'Run Migration'}
                </Button>
              </Group>
            </Stack>
          </Card>

          {lastResult && (
            <Card shadow="sm" padding="lg" radius="md" withBorder bg={lastResult.dryRun ? 'blue.0' : 'green.0'}>
              <Stack gap="sm">
                <Group gap="sm">
                  {lastResult.dryRun ? (
                    <Info size={20} color="var(--mantine-color-blue-6)" />
                  ) : (
                    <CheckCircle2 size={20} color="green" />
                  )}
                  <Title order={4}>{lastResult.dryRun ? 'Last Dry Run Result' : 'Last Migration Result'}</Title>
                </Group>

                {lastResult.dryRun && (
                  <Alert icon={<Info size={16} />} color="blue" variant="light" p="xs">
                    <Text size="sm">
                      Dry run — these are the changes that <strong>would</strong> be made. Nothing was written.
                    </Text>
                  </Alert>
                )}

                <Group gap="md">
                  <div>
                    <Text size="xs" c="dimmed">
                      Migration
                    </Text>
                    <Text size="sm" fw={500}>
                      {lastResult.migrationName}
                    </Text>
                  </div>
                  <div>
                    <Text size="xs" c="dimmed">
                      {lastResult.dryRun ? 'Would migrate' : 'Migrated'}
                    </Text>
                    <Text size="sm" fw={500}>
                      {formatNumber(lastResult.migratedIds.length)} items
                    </Text>
                  </div>
                  <div>
                    <Text size="xs" c="dimmed">
                      {lastResult.dryRun ? 'Would remain' : 'Remaining'}
                    </Text>
                    <Text size="sm" fw={500}>
                      {formatNumber(lastResult.remainingCount)} items
                    </Text>
                  </div>
                </Group>

                {lastResult.summary && lastResult.summary.length > 0 && (
                  <div>
                    <Text size="xs" c="dimmed" mb={4}>
                      Breakdown
                    </Text>
                    <Stack gap={2}>
                      {lastResult.summary.map((row) => (
                        <Group key={row.label} gap="xs" justify="space-between" maw={420}>
                          <Text size="sm">{row.label}</Text>
                          <Text size="sm" fw={500} ff="monospace">
                            {formatNumber(row.count)}
                          </Text>
                        </Group>
                      ))}
                    </Stack>
                  </div>
                )}

                {lastResult.migratedIds.length > 0 && (
                  <div>
                    <Text size="xs" c="dimmed" mb={4}>
                      {lastResult.dryRun ? 'Would-migrate IDs' : 'Migrated IDs'}
                    </Text>
                    <Text size="xs" ff="monospace" style={{ wordBreak: 'break-all' }}>
                      {lastResult.migratedIds.join(', ')}
                    </Text>
                  </div>
                )}
              </Stack>
            </Card>
          )}
        </Stack>
      </MainContent.Body>
    </MainContent>
  );
}
