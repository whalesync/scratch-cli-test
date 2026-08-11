'use client';

import { Text12Medium, Text13Regular, TextTitle3 } from '@/app/components/base/text';
import { formatNumber } from '@/utils/helpers';
import { RouteUrls } from '@/utils/route-urls';
import { Box, Group, Stack, Table } from '@mantine/core';
import {
  categorizeJobType,
  deriveJobResult,
  isJobStillRunning,
  type Job,
  type JobResult,
  type JobResultFile,
} from '@spinner/shared-types';
import Link from 'next/link';
import { useParams } from 'next/navigation';

/**
 * Expanded progress detail for a single job, rendered identically wherever a job appears (RunsView and
 * RoutineRunHistory). The failed reason (if any) plus a normalized, render-ready {@link JobResult} —
 * a headline stat line, a per-folder/table breakdown, impacted files, and errors/warnings — all
 * computed by the SHARED {@link deriveJobResult} so the web client, desktop app, and CLI render the
 * same thing. Connector-agnostic AND job-type-agnostic: the only per-type knowledge (which raw field
 * means "created", how to phrase the headline) lives in the shared helper, not here.
 */
export function JobProgressDetail({ job }: { job: Job }) {
  // A job that hasn't reached a terminal state is described in the present tense ("Pulling Companies —
  // 1,200 records fetched") rather than as a finished tally of counters that are still moving.
  const result = deriveJobResult({
    type: job.type,
    publicProgress: job.publicProgress,
    isRunning: isJobStillRunning(job.state),
  });
  // Rehost has no normalized renderer yet — fall back to its bespoke table below.
  const isRehost = categorizeJobType(job.type) === 'rehost';

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
        {isRehost ? (
          <RehostProgressTable
            progress={
              job.publicProgress && typeof job.publicProgress === 'object'
                ? (job.publicProgress as Record<string, unknown>)
                : {}
            }
          />
        ) : (
          <JobResultView result={result} />
        )}
      </Stack>
    </Box>
  );
}

/**
 * Renders a job's progress detail from its raw `type` + `publicProgress`. Exported for RunsView, which
 * holds the type and progress separately rather than a whole {@link Job}.
 */
export function ProgressDetails({
  type,
  progress,
  jobState,
}: {
  type: string;
  progress: Record<string, unknown>;
  /** The job's state, so a job still in flight renders as progress rather than as a final result. */
  jobState?: Job['state'];
}) {
  if (categorizeJobType(type) === 'rehost') {
    return <RehostProgressTable progress={progress} />;
  }
  return (
    <JobResultView
      result={deriveJobResult({ type, publicProgress: progress, isRunning: isJobStillRunning(jobState) })}
    />
  );
}

/** Renders a normalized job result: headline stats, per-folder breakdown, errors/warnings, and files. */
export function JobResultView({ result }: { result: JobResult }) {
  const hasAnything =
    result.summary ||
    result.stats.length > 0 ||
    result.folders.length > 0 ||
    result.files.length > 0 ||
    result.errors.length > 0 ||
    result.warnings.length > 0;
  if (!hasAnything) return null;

  return (
    <Stack gap="xs">
      {result.summary && <Text13Regular c="var(--fg-primary)">{result.summary}</Text13Regular>}
      <JobStatLine stats={result.stats} />
      {result.folders.length > 0 && <FolderBreakdownTable folders={result.folders} />}
      {result.errors.length > 0 && (
        <MessageList title="Errors" messages={result.errors} color="var(--mantine-color-red-6)" />
      )}
      {result.warnings.length > 0 && (
        <MessageList title="Warnings" messages={result.warnings} color="var(--mantine-color-orange-6)" />
      )}
      <AffectedFilesTable files={result.files} />
    </Stack>
  );
}

/** The headline counters, e.g. "10 New · 0 Updated · 0 Deleted · 3 Unchanged". */
export function JobStatLine({ stats }: { stats: JobResult['stats'] }) {
  if (stats.length === 0) return null;
  return (
    <Group gap="md">
      {stats.map((stat) => (
        <Group key={stat.label} gap={4}>
          <Text12Medium c="var(--fg-primary)">{formatNumber(stat.value)}</Text12Medium>
          <Text13Regular c="var(--fg-secondary)">{stat.label}</Text13Regular>
        </Group>
      ))}
    </Group>
  );
}

/**
 * Uniform per-folder/table breakdown — the SAME table for pull (folders) and sync (tables), since both
 * derive into {@link JobResult.folders}. Columns adapt to whichever optional dimensions are present.
 */
function FolderBreakdownTable({ folders }: { folders: JobResult['folders'] }) {
  const hasSkipped = folders.some((folder) => folder.skipped > 0);
  const hasErrors = folders.some((folder) => folder.errorCount > 0);
  const hasWarnings = folders.some((folder) => folder.warningCount > 0);

  return (
    <Table striped highlightOnHover withColumnBorders>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Folder</Table.Th>
          <Table.Th>Source</Table.Th>
          <Table.Th>Created</Table.Th>
          <Table.Th>Updated</Table.Th>
          <Table.Th>Deleted</Table.Th>
          {hasSkipped && <Table.Th>Skipped</Table.Th>}
          {hasErrors && <Table.Th>Errors</Table.Th>}
          {hasWarnings && <Table.Th>Warnings</Table.Th>}
          <Table.Th>Status</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {folders.map((folder, index) => (
          <Table.Tr key={folder.id ?? index}>
            <Table.Td>{folder.name || `Folder ${index + 1}`}</Table.Td>
            <Table.Td>{folder.connector ?? '-'}</Table.Td>
            <Table.Td>{formatNumber(folder.created)}</Table.Td>
            <Table.Td>{formatNumber(folder.updated)}</Table.Td>
            <Table.Td>{formatNumber(folder.deleted)}</Table.Td>
            {hasSkipped && (
              <Table.Td>
                <Text13Regular c="dimmed">{formatNumber(folder.skipped)}</Text13Regular>
              </Table.Td>
            )}
            {hasErrors && (
              <Table.Td>
                <Text13Regular c={folder.errorCount ? 'var(--mantine-color-red-6)' : undefined}>
                  {formatNumber(folder.errorCount)}
                </Text13Regular>
              </Table.Td>
            )}
            {hasWarnings && (
              <Table.Td>
                <Text13Regular c={folder.warningCount ? 'var(--mantine-color-orange-6)' : undefined}>
                  {formatNumber(folder.warningCount)}
                </Text13Regular>
              </Table.Td>
            )}
            <Table.Td>{folder.status ?? '-'}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

/** A titled list of user-facing error/warning messages. */
function MessageList({ title, messages, color }: { title: string; messages: string[]; color: string }) {
  return (
    <Box>
      <Text12Medium c={color} mb={4}>
        {title} ({messages.length >= 100 ? '100+' : messages.length})
      </Text12Medium>
      <Stack gap={2}>
        {messages.map((message, index) => (
          <Text13Regular key={index} c={color}>
            {message}
          </Text13Regular>
        ))}
      </Stack>
    </Box>
  );
}

function AffectedFilesTable({ files }: { files: JobResultFile[] }) {
  const params = useParams<{ id: string }>();
  const workbookId = params.id;

  if (files.length === 0) return null;

  return (
    <Box mt="xs">
      <Text12Medium c="var(--fg-secondary)" mb={4}>
        Affected Files ({formatNumber(files.length)})
      </Text12Medium>
      <Table striped highlightOnHover withColumnBorders>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>File Path</Table.Th>
            <Table.Th>Operation</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {files.map((file, index) => (
            <Table.Tr key={index}>
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

/**
 * Rehost (asset re-hosting) progress. Not yet covered by the normalized {@link deriveJobResult}, so it
 * still reads its own `publicProgress` shape here. Connector-agnostic.
 */
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
            <Table.Td>{formatNumber(totalAssets)}</Table.Td>
            <Table.Td>
              <Text13Regular c={succeeded ? 'var(--mantine-color-green-6)' : undefined}>
                {formatNumber(succeeded ?? 0)}
              </Text13Regular>
            </Table.Td>
            <Table.Td>
              <Text13Regular c={failed ? 'var(--mantine-color-red-6)' : undefined}>
                {formatNumber(failed ?? 0)}
              </Text13Regular>
            </Table.Td>
            <Table.Td>{status ?? '-'}</Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>
      {failures.length > 0 && (
        <Box mt="xs">
          <TextTitle3 c="var(--mantine-color-red-6)" mb={4}>
            Failures ({formatNumber(failures.length)})
          </TextTitle3>
          <Table striped highlightOnHover withColumnBorders>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Filename</Table.Th>
                <Table.Th>Error</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {failures.map((failure, index) => (
                <Table.Tr key={index}>
                  <Table.Td style={{ fontFamily: 'monospace', fontSize: 12 }}>{failure.filename ?? '—'}</Table.Td>
                  <Table.Td>
                    <Text13Regular c="var(--mantine-color-red-6)">{failure.error}</Text13Regular>
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
