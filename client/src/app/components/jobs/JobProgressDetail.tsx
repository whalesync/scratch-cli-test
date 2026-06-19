'use client';

import { Text12Medium, Text13Regular, TextTitle3 } from '@/app/components/base/text';
import { getJobType, JobType } from '@/utils/job-helpers';
import { RouteUrls } from '@/utils/route-urls';
import { Box, Stack, Table } from '@mantine/core';
import type { Job } from '@spinner/shared-types';
import Link from 'next/link';
import { useParams } from 'next/navigation';

/**
 * Expanded progress detail for a single job, rendered identically to the Runs view: the failed
 * reason (if any) plus the per-job-type progress table (sync / pull / publish / rehost) driven off
 * the job's generic `publicProgress`. Shared by RunsView and RoutineRunHistory so a job looks the
 * same wherever it appears. Connector-agnostic — nothing here branches on a service.
 */
export function JobProgressDetail({ job }: { job: Job }) {
  const jobType = getJobType(job.type);
  const progress =
    job.publicProgress && typeof job.publicProgress === 'object'
      ? (job.publicProgress as Record<string, unknown>)
      : null;

  return (
    <Box px="md" py="sm" style={{ background: 'var(--bg-panel)' }}>
      <Stack gap="sm">
        {job.failedReason && (
          <Box>
            <Text12Medium c="var(--fg-secondary)" mb={4}>
              Failed Reason
            </Text12Medium>
            <Text13Regular c="var(--mantine-color-red-6)">{job.failedReason}</Text13Regular>
          </Box>
        )}
        {progress && <ProgressDetails jobType={jobType} progress={progress} />}
      </Stack>
    </Box>
  );
}

/** Dispatches to the right progress table for a job category. Exported for reuse by RunsView. */
export function ProgressDetails({ jobType, progress }: { jobType: JobType; progress: Record<string, unknown> }) {
  switch (jobType) {
    case 'sync':
      return <SyncProgressTable progress={progress} />;
    case 'publish':
      return <PublishProgressTable progress={progress} />;
    case 'pull':
      return <PullProgressTable progress={progress} />;
    case 'rehost':
      return <RehostProgressTable progress={progress} />;
    default:
      return null;
  }
}

type PathSource = {
  createdPaths?: string[];
  updatedPaths?: string[];
  deletedPaths?: string[];
  refreshedPaths?: string[];
};

function collectAffectedFiles(sources: PathSource[]): Array<{ path: string; operation: string }> {
  const files: Array<{ path: string; operation: string }> = [];
  for (const source of sources) {
    if (source.createdPaths) {
      for (const p of source.createdPaths) files.push({ path: p, operation: 'Created' });
    }
    if (source.updatedPaths) {
      for (const p of source.updatedPaths) files.push({ path: p, operation: 'Updated' });
    }
    if (source.deletedPaths) {
      for (const p of source.deletedPaths) files.push({ path: p, operation: 'Deleted' });
    }
    if (source.refreshedPaths) {
      for (const p of source.refreshedPaths) files.push({ path: p, operation: 'Refreshed' });
    }
  }
  return files;
}

function AffectedFilesTable({ files }: { files: Array<{ path: string; operation: string }> }) {
  const params = useParams<{ id: string }>();
  const workbookId = params.id;

  if (files.length === 0) return null;

  return (
    <Box mt="xs">
      <Text12Medium c="var(--fg-secondary)" mb={4}>
        Affected Files ({files.length})
      </Text12Medium>
      <Table striped highlightOnHover withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>File Path</Table.Th>
            <Table.Th>Operation</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {files.map((file, i) => (
            <Table.Tr key={i}>
              <Table.Td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                <Link
                  href={RouteUrls.workbookFilesFileUrl(workbookId, file.path)}
                  style={{ color: 'inherit', textDecoration: 'underline' }}
                >
                  {file.path}
                </Link>
              </Table.Td>
              <Table.Td>{file.operation}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Box>
  );
}

function SyncProgressTable({ progress }: { progress: Record<string, unknown> }) {
  if (!progress.tables || !Array.isArray(progress.tables)) return null;
  const tables = progress.tables as Array<{
    name?: string;
    connector?: string;
    creates?: number;
    updates?: number;
    deletes?: number;
    skipped?: number;
    errorCount?: number;
    warningCount?: number;
    createdPaths?: string[];
    updatedPaths?: string[];
    deletedPaths?: string[];
    errors?: Array<{ sourceRemoteId?: string; error?: string }>;
    warnings?: Array<{ sourceRemoteId?: string; warning?: string }>;
    status?: string;
  }>;
  if (tables.length === 0) return null;

  const affectedFiles = collectAffectedFiles(tables);
  const hasSkipped = tables.some((t) => (t.skipped ?? 0) > 0);
  const hasErrors = tables.some((t) => (t.errorCount ?? t.errors?.length ?? 0) > 0);
  const hasWarnings = tables.some((t) => (t.warningCount ?? t.warnings?.length ?? 0) > 0);
  const allErrors = tables.flatMap((t) =>
    (t.errors ?? []).map((e) => ({ tableName: t.name, sourceRemoteId: e.sourceRemoteId, error: e.error })),
  );
  const allWarnings = tables.flatMap((t) =>
    (t.warnings ?? []).map((w) => ({ tableName: t.name, sourceRemoteId: w.sourceRemoteId, warning: w.warning })),
  );

  return (
    <>
      <Table striped highlightOnHover withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Table</Table.Th>
            <Table.Th>Source</Table.Th>
            <Table.Th>Creates</Table.Th>
            <Table.Th>Updates</Table.Th>
            <Table.Th>Deletes</Table.Th>
            {hasSkipped && <Table.Th>Skipped</Table.Th>}
            {hasErrors && <Table.Th>Errors</Table.Th>}
            {hasWarnings && <Table.Th>Warnings</Table.Th>}
            <Table.Th>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {tables.map((table, i) => (
            <Table.Tr key={i}>
              <Table.Td>{table.name || `Table ${i + 1}`}</Table.Td>
              <Table.Td>{table.connector ?? '-'}</Table.Td>
              <Table.Td>{table.creates ?? 0}</Table.Td>
              <Table.Td>{table.updates ?? 0}</Table.Td>
              <Table.Td>{table.deletes ?? 0}</Table.Td>
              {hasSkipped && (
                <Table.Td>
                  <Text13Regular c="dimmed">{table.skipped ?? 0}</Text13Regular>
                </Table.Td>
              )}
              {hasErrors && (
                <Table.Td>
                  <Text13Regular c={table.errorCount ? 'var(--mantine-color-red-6)' : undefined}>
                    {table.errorCount ?? table.errors?.length ?? 0}
                  </Text13Regular>
                </Table.Td>
              )}
              {hasWarnings && (
                <Table.Td>
                  <Text13Regular
                    c={
                      (table.warningCount ?? table.warnings?.length ?? 0) > 0
                        ? 'var(--mantine-color-orange-6)'
                        : undefined
                    }
                  >
                    {table.warningCount ?? table.warnings?.length ?? 0}
                  </Text13Regular>
                </Table.Td>
              )}
              <Table.Td>{table.status ?? '-'}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {allErrors.length > 0 && <SyncErrorsTable errors={allErrors} />}
      {allWarnings.length > 0 && <SyncWarningsTable warnings={allWarnings} />}
      <AffectedFilesTable files={affectedFiles} />
    </>
  );
}

function SyncErrorsTable({
  errors,
}: {
  errors: Array<{ tableName?: string; sourceRemoteId?: string; error?: string }>;
}) {
  return (
    <Box mt="xs">
      <Text12Medium c="var(--mantine-color-red-6)" mb={4}>
        Errors ({errors.length >= 100 ? '100+' : errors.length})
      </Text12Medium>
      <Table striped highlightOnHover withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Table</Table.Th>
            <Table.Th>Source Record</Table.Th>
            <Table.Th>Error</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {errors.map((err, i) => (
            <Table.Tr key={i}>
              <Table.Td>{err.tableName ?? '-'}</Table.Td>
              <Table.Td style={{ fontFamily: 'monospace', fontSize: 12 }}>{err.sourceRemoteId ?? '-'}</Table.Td>
              <Table.Td>
                <Text13Regular c="var(--mantine-color-red-6)">{err.error ?? 'Unknown error'}</Text13Regular>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Box>
  );
}

function SyncWarningsTable({
  warnings,
}: {
  warnings: Array<{ tableName?: string; sourceRemoteId?: string; warning?: string }>;
}) {
  return (
    <Box mt="xs">
      <Text12Medium c="var(--mantine-color-orange-6)" mb={4}>
        Warnings ({warnings.length >= 100 ? '100+' : warnings.length})
      </Text12Medium>
      <Table striped highlightOnHover withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Table</Table.Th>
            <Table.Th>Source Record</Table.Th>
            <Table.Th>Warning</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {warnings.map((warn, i) => (
            <Table.Tr key={i}>
              <Table.Td>{warn.tableName ?? '-'}</Table.Td>
              <Table.Td style={{ fontFamily: 'monospace', fontSize: 12 }}>{warn.sourceRemoteId ?? '-'}</Table.Td>
              <Table.Td>
                <Text13Regular c="var(--mantine-color-orange-6)">{warn.warning ?? 'Unknown warning'}</Text13Regular>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Box>
  );
}

function PublishProgressTable({ progress }: { progress: Record<string, unknown> }) {
  if (!progress.folders || !Array.isArray(progress.folders)) {
    const connectionName = progress.connectionName as string | undefined;
    const tableName = progress.tableName as string | undefined;
    const currentTableName = progress.currentTableName as string | undefined;
    const tableCount = progress.tableCount as number | undefined;
    const currentPhase = progress.currentPhase as string | undefined;
    const processedCount = progress.processedCount as number | undefined;
    const totalCount = progress.totalCount as number | undefined;
    const successCount = progress.successCount as number | undefined;
    const failedCount = progress.failedCount as number | undefined;
    const status = progress.status as string | undefined;

    if (totalCount === undefined) return null;

    return (
      <>
        <Table striped highlightOnHover withColumnBorders>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Connection</Table.Th>
              <Table.Th>Scope</Table.Th>
              <Table.Th>Current Phase</Table.Th>
              <Table.Th>Processed</Table.Th>
              <Table.Th>Succeeded</Table.Th>
              <Table.Th>Failed</Table.Th>
              <Table.Th>Status</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            <Table.Tr>
              <Table.Td>{connectionName || '-'}</Table.Td>
              <Table.Td>{tableName || currentTableName || (tableCount ? `${tableCount} tables` : '-')}</Table.Td>
              <Table.Td>{currentPhase || '-'}</Table.Td>
              <Table.Td>
                {processedCount ?? 0} / {totalCount}
              </Table.Td>
              <Table.Td>{successCount ?? 0}</Table.Td>
              <Table.Td>
                <Text13Regular c={failedCount ? 'var(--mantine-color-red-6)' : undefined}>
                  {failedCount ?? 0}
                </Text13Regular>
              </Table.Td>
              <Table.Td>{status ?? '-'}</Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
      </>
    );
  }
  const folders = progress.folders as Array<{
    name?: string;
    connector?: string;
    creates?: number;
    updates?: number;
    deletes?: number;
    expectedCreates?: number;
    expectedUpdates?: number;
    expectedDeletes?: number;
    createdPaths?: string[];
    updatedPaths?: string[];
    deletedPaths?: string[];
    status?: string;
  }>;
  if (folders.length === 0) return null;

  const affectedFiles = collectAffectedFiles(folders);

  return (
    <>
      <Table striped highlightOnHover withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Folder</Table.Th>
            <Table.Th>Source</Table.Th>
            <Table.Th>Creates</Table.Th>
            <Table.Th>Updates</Table.Th>
            <Table.Th>Deletes</Table.Th>
            <Table.Th>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {folders.map((folder, i) => (
            <Table.Tr key={i}>
              <Table.Td>{folder.name || `Folder ${i + 1}`}</Table.Td>
              <Table.Td>{folder.connector ?? '-'}</Table.Td>
              <Table.Td>
                {folder.creates ?? 0} / {folder.expectedCreates ?? 0}
              </Table.Td>
              <Table.Td>
                {folder.updates ?? 0} / {folder.expectedUpdates ?? 0}
              </Table.Td>
              <Table.Td>
                {folder.deletes ?? 0} / {folder.expectedDeletes ?? 0}
              </Table.Td>
              <Table.Td>{folder.status ?? '-'}</Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <AffectedFilesTable files={affectedFiles} />
    </>
  );
}

function RehostProgressTable({ progress }: { progress: Record<string, unknown> }) {
  const dataFolderName = progress.dataFolderName as string | undefined;
  const totalAssets = progress.totalAssets as number | undefined;
  const succeeded = progress.succeeded as number | undefined;
  const failed = progress.failed as number | undefined;
  const status = progress.status as string | undefined;
  const failures =
    (progress.failures as Array<{ assetId: string; filename: string | null; error: string }> | undefined) ?? [];

  if (totalAssets === undefined) return null;

  return (
    <>
      <Table striped highlightOnHover withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Folder</Table.Th>
            <Table.Th>Total Assets</Table.Th>
            <Table.Th>Succeeded</Table.Th>
            <Table.Th>Failed</Table.Th>
            <Table.Th>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          <Table.Tr>
            <Table.Td>{dataFolderName ?? '-'}</Table.Td>
            <Table.Td>{totalAssets}</Table.Td>
            <Table.Td>
              <Text13Regular c={succeeded ? 'var(--mantine-color-green-6)' : undefined}>{succeeded ?? 0}</Text13Regular>
            </Table.Td>
            <Table.Td>
              <Text13Regular c={failed ? 'var(--mantine-color-red-6)' : undefined}>{failed ?? 0}</Text13Regular>
            </Table.Td>
            <Table.Td>{status ?? '-'}</Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>
      {failures.length > 0 && (
        <Box mt="xs">
          <TextTitle3 c="var(--mantine-color-red-6)" mb={4}>
            Failures ({failures.length})
          </TextTitle3>
          <Table striped highlightOnHover withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Filename</Table.Th>
                <Table.Th>Error</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {failures.map((f, i) => (
                <Table.Tr key={i}>
                  <Table.Td style={{ fontFamily: 'monospace', fontSize: 12 }}>{f.filename ?? '—'}</Table.Td>
                  <Table.Td>
                    <Text13Regular c="var(--mantine-color-red-6)">{f.error}</Text13Regular>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Box>
      )}
    </>
  );
}

function PullProgressTable({ progress }: { progress: Record<string, unknown> }) {
  const folderName = progress.folderName as string | undefined;
  const connector = progress.connector as string | undefined;
  const totalFiles = (progress.totalFiles ?? progress.totalRequested) as number | undefined;
  const status = progress.status as string | undefined;
  const mode = progress.mode as 'full' | 'incremental' | undefined;
  const typeLabel = mode === 'incremental' ? 'Incremental' : mode === 'full' ? 'Full' : '-';
  const createdPaths = (progress.createdPaths as string[] | undefined) ?? [];
  const updatedPaths = (progress.updatedPaths as string[] | undefined) ?? [];
  const deletedPaths = (progress.deletedPaths as string[] | undefined) ?? [];
  // Prefer actual counts (not capped) when available; fall back to path array lengths
  const createdCount = (progress.createdCount as number | undefined) ?? createdPaths.length;
  const updatedCount = (progress.updatedCount as number | undefined) ?? updatedPaths.length;
  const deletedCount = (progress.deletedCount as number | undefined) ?? deletedPaths.length;
  const folderErrors = progress.folderErrors as
    | Record<string, { folderName: string; message: string; details?: string }>
    | undefined;
  const folderErrorEntries = folderErrors ? Object.entries(folderErrors) : [];

  if (!folderName && totalFiles === undefined) return null;

  const affectedFiles = collectAffectedFiles([{ createdPaths, updatedPaths, deletedPaths }]);

  return (
    <>
      <Table striped highlightOnHover withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Folder</Table.Th>
            <Table.Th>Source</Table.Th>
            <Table.Th>Created</Table.Th>
            <Table.Th>Updated</Table.Th>
            {deletedCount > 0 && <Table.Th>Deleted</Table.Th>}
            <Table.Th>Fetched</Table.Th>
            <Table.Th>Type</Table.Th>
            <Table.Th>Status</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          <Table.Tr>
            <Table.Td>{folderName || 'Folder'}</Table.Td>
            <Table.Td>{connector ?? '-'}</Table.Td>
            <Table.Td>{createdCount}</Table.Td>
            <Table.Td>{updatedCount}</Table.Td>
            {deletedCount > 0 && <Table.Td>{deletedCount}</Table.Td>}
            <Table.Td>{totalFiles ?? 0}</Table.Td>
            <Table.Td>{typeLabel}</Table.Td>
            <Table.Td>{status ?? '-'}</Table.Td>
          </Table.Tr>
          {folderErrorEntries.map(([folderId, folderError]) => (
            <Table.Tr key={folderId}>
              <Table.Td>{folderError.folderName}</Table.Td>
              <Table.Td>{connector ?? '-'}</Table.Td>
              <Table.Td colSpan={deletedCount > 0 ? 4 : 3}>
                <Stack gap={2}>
                  <Text13Regular c="var(--mantine-color-red-6)">{folderError.message}</Text13Regular>
                  {folderError.details && <Text13Regular c="dimmed">{folderError.details}</Text13Regular>}
                </Stack>
              </Table.Td>
              <Table.Td>-</Table.Td>
              <Table.Td>
                <Text13Regular c="var(--mantine-color-red-6)">failed</Text13Regular>
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <AffectedFilesTable files={affectedFiles} />
    </>
  );
}
