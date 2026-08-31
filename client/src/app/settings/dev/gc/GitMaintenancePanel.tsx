'use client';

import { useGitMaintenance } from '@/hooks/use-git-maintenance';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  Group,
  Loader,
  Paper,
  Stack,
  Switch,
  Table,
  Tabs,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import {
  GitMaintenanceRepoRow,
  GitMaintenanceRun,
  GitMaintenanceSettingRow,
  GitMaintenanceStepOutcome,
  GitMaintenanceTickRow,
} from '@spinner/shared-types';
import {
  BoxesIcon,
  CircleDashedIcon,
  EyeIcon,
  FastForwardIcon,
  HelpCircleIcon,
  InfoIcon,
  PackageIcon,
  PlayIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { useState } from 'react';

const formatMs = (ms: number): string =>
  ms >= 60_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`;
const formatBytes = (bytes: number): string =>
  bytes >= 1 << 30 ? `${(bytes / (1 << 30)).toFixed(2)} GiB` : `${(bytes / (1 << 20)).toFixed(1)} MiB`;

/** "3 min ago", "5 h ago", "12 d ago" — coarse on purpose; the exact time is on the line above. */
const formatAgo = (ms: number): string => {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

const stateColor = (outcome: GitMaintenanceStepOutcome): string => {
  if (outcome.state !== 'completed') return 'red';
  if (outcome.fsckClean === false) return 'red';
  return 'green';
};

const planColor = (plan: GitMaintenanceRepoRow['plan']): string =>
  plan === 'full' ? 'orange' : plan === 'quick' ? 'blue' : 'gray';

/** Three lines: date, time, how long ago. Null/0 = never. */
function When({ ms }: { ms: number | null | undefined }) {
  if (!ms) {
    return (
      <Text size="xs" c="dimmed">
        never
      </Text>
    );
  }
  const date = new Date(ms);
  return (
    <Stack gap={0}>
      <Text size="xs">{date.toLocaleDateString()}</Text>
      <Text size="xs">{date.toLocaleTimeString()}</Text>
      <Text size="xs" c="dimmed">
        {formatAgo(ms)}
      </Text>
    </Stack>
  );
}

/** `org_x/wkb_y/coa_z` on three lines. */
function RepoId({ repoId }: { repoId: string }) {
  return (
    <Stack gap={0}>
      {repoId.split('/').map((segment, index) => (
        <Code key={index}>{segment}</Code>
      ))}
    </Stack>
  );
}

/** One line of the Objects cell: icon · count · size · (share%). */
function ObjectLine({
  icon,
  label,
  count,
  bytes,
  totalBytes,
  emphasize,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  bytes: number;
  totalBytes: number;
  emphasize?: boolean;
}) {
  const share = totalBytes > 0 ? ` (${((bytes / totalBytes) * 100).toFixed(0)}%)` : '';
  return (
    <Tooltip label={label} withArrow position="left">
      <Group gap={6} wrap="nowrap">
        {icon}
        <Text size="xs" fw={emphasize ? 600 : undefined} style={{ whiteSpace: 'nowrap' }}>
          {count} · {formatBytes(bytes)}
          {share}
        </Text>
      </Group>
    </Tooltip>
  );
}

/** loose / small packs / biggest pack — count · size · share of the repo's object bytes. */
function ObjectsCell({ row }: { row: GitMaintenanceRepoRow }) {
  const smallPacksBytes = Math.max(0, row.packBytes - row.largestPackBytes);
  const totalBytes = row.looseBytes + row.packBytes;
  const iconStyle = { color: 'var(--mantine-color-dimmed)', flexShrink: 0 } as const;
  return (
    <Stack gap={2}>
      <ObjectLine
        icon={<CircleDashedIcon size={14} style={iconStyle} />}
        label="Loose objects — unpacked files; a quick step packs them"
        count={row.loose}
        bytes={row.looseBytes}
        totalBytes={totalBytes}
        emphasize={row.loose >= 500}
      />
      <ObjectLine
        icon={<BoxesIcon size={14} style={iconStyle} />}
        label="Small packs — every pack except the biggest; roll-ups merge them"
        count={Math.max(0, row.packs - 1)}
        bytes={smallPacksBytes}
        totalBytes={totalBytes}
        emphasize={row.packs > 10 || row.smallPackShare >= 0.15}
      />
      <ObjectLine
        icon={<PackageIcon size={14} style={iconStyle} />}
        label="Biggest pack — the consolidated main pack; the ideal repo is just this"
        count={row.packs > 0 ? 1 : 0}
        bytes={row.largestPackBytes}
        totalBytes={totalBytes}
      />
    </Stack>
  );
}

/** `before` on one line, `→ after` on the next. */
function BeforeAfter({ before, after }: { before: string; after: string }) {
  return (
    <Stack gap={0}>
      <Text size="sm">{before}</Text>
      <Text size="sm">→ {after}</Text>
    </Stack>
  );
}

/** Column header with a (?) tooltip explaining where the value comes from and how it is used. */
function Th({ label, help }: { label: string; help: string }) {
  return (
    <Table.Th>
      <Group gap={4} wrap="nowrap">
        <span>{label}</span>
        <Tooltip
          label={help}
          multiline
          w={340}
          withArrow
          position="top-start"
          events={{ hover: true, focus: true, touch: true }}
        >
          <HelpCircleIcon size={13} style={{ color: 'var(--mantine-color-dimmed)', flexShrink: 0, cursor: 'help' }} />
        </Tooltip>
      </Group>
    </Table.Th>
  );
}

const HELP = {
  repo: 'The bare repo under the repos directory, split as organisation / workbook / connection.',
  created:
    "Creation (birth) time of the repo directory on disk, straight from the filesystem — works regardless of whether this server's database knows the repo. Not used in any decision.",
  user: "The user owning the repo's workbook (repo id → workbook → user), looked up by the server. Blank for repos whose workbook no longer exists in this database.",
  objects:
    'Three lines, each: count · storage size · share of the repo bytes. ⭘ LOOSE = unpacked object files under objects/xx/ — the disk bloat and read-performance problem; a QUICK step is due at ≥ 500 of them. ▣ SMALL PACKS = every *.pack except the biggest; > 10 packs makes a QUICK (roll-up) due, and ≥ 15% of the bytes sitting outside the biggest pack makes a FULL due. ⬒ BIGGEST PACK = the consolidated main pack; the ideal repo is one pack (plus possibly a small cruft pack of aging garbage), no loose. All counted on disk at scan time.',
  lastWrite:
    'DERIVED from disk: the newest modification time in the refs/ tree (every branch/tag update renames a lock file into it) and of packed-refs. Decision: counts as "activity since the last full" — a FULL only runs when something changed after it.',
  lastQuick:
    'DERIVED from disk: the newest *.pack file mtime. Every quick and every full creates a pack — so does a received git push, which then just delays the next quick. Decision: rate-limits QUICK to at most once per hour. "never" = no pack exists.',
  lastFull:
    'DERIVED from disk: the mtime of objects/info/commit-graph — only a real git gc writes that file (a manual /gc or /repair counts too, as it should). Decision: rate-limits FULL to at most once per day; over 7 days old forces one if there was activity. Nothing is stored — a deleted journal DB changes nothing here.',
  nextTick:
    'The decision the loop would take right now, computed from the columns to the left: FULL if activity since the last full AND last full ≥ 24 h ago AND (small-pack share ≥ 15% OR packs > 10 OR last full > 7 d). Else QUICK if last quick ≥ 1 h ago AND (loose ≥ 500 OR packs > 10). Else NOTHING. The reason line shows which rule fired.',
  runWhen: 'When the step started — date, time, and how long ago.',
  runMode:
    'quick = pack all loose objects + prune-packed + geometric repack (deletes nothing, safe next to writers). full = git gc --cruft --prune=1.hour.ago with bitmaps off, then an fsck canary: reachable objects → one pack, young garbage → a cruft pack with per-object ages (deleted at a later full once past the grace), old garbage → deleted. The line underneath is the reason it was due.',
  runState:
    'completed (green) is the good case. failed / timed_out / aborted: the step did not finish — nothing advanced, the repo stays due and is retried. fsck_failed / fsck_inconclusive: the gc itself completed but the fsck canary found a problem / could not finish — look at stderr.',
  runLoose: 'Loose-object count on disk, before → after the step.',
  runPacks: 'Pack count on disk, before → after the step.',
  runPackedBytes: 'Total pack bytes on disk, before → after the step.',
  runDuration: 'Wall clock of the whole step, including the fsck on full steps.',
  runCommands: 'The exact git commands that ran, in order.',
  tickStarted: 'When this pass of the 60-second loop began.',
  tickDuration:
    'Whole pass, including any steps it ran; "scan" is just reading every repo (a few stats each, no git processes).',
  tickRepos:
    'Repos scanned; "unreadable" = repos or directories the scan could not read — they are skipped, and this should always be 0.',
  tickDue: 'How many repos qualified for a quick / full step at this pass (before markers and locks).',
  tickRan:
    'Steps actually executed this pass (repos skipped because a manual GC or the other container held the lock are not counted).',
  tickAborted: 'The pass was cut short — shutdown, or the switch was turned off mid-pass.',
  settingKey: 'Raw rows of the maintenance DB settings table. Today there is exactly one key: enabled.',
  settingValue:
    '1 = the background loop runs; 0 / no row = off. Written by the switch above; read once when scratch-git starts.',
  settingUpdated: 'When this setting was last written.',
} as const;

type PanelTab = 'repos' | 'runs' | 'ticks' | 'settings';

/**
 * scratch-git background maintenance (DEV-11316): the switch, what the 60 s loop is doing, and the
 * maintenance DB's tables rendered plainly — repos (derived state + the decision the next tick would
 * take), the run journal (all repos or one), the tick journal, and settings. The switch is persisted
 * in the maintenance DB by scratch-git itself; the server only proxies. While ON, the after-job
 * `/gc` calls are no-ops and this loop owns all compaction and pruning.
 */
export function GitMaintenancePanel() {
  const { config, status, settings, repos, ticks, runs, runsRepo, setRunsRepo, isLoading, error, setEnabled, refresh } =
    useGitMaintenance();
  const [isSaving, setIsSaving] = useState(false);
  const [tab, setTab] = useState<PanelTab>('repos');

  const handleToggle = async (enabled: boolean) => {
    setIsSaving(true);
    try {
      const updated = await setEnabled(enabled);
      notifications.show({
        title: updated.enabled ? 'Background maintenance enabled' : 'Background maintenance disabled',
        message: updated.enabled
          ? 'scratch-git will GC repos from its own loop; after-job GC calls are now no-ops.'
          : 'After-job GC calls run git gc again, as before.',
        color: updated.enabled ? 'green' : 'gray',
      });
    } catch (e) {
      notifications.show({ title: 'Error', message: `Failed to update the switch: ${String(e)}`, color: 'red' });
    } finally {
      setIsSaving(false);
    }
  };

  const showRunsFor = (repoId: string) => {
    setRunsRepo(repoId);
    setTab('runs');
  };

  const [runningKey, setRunningKey] = useState<string | null>(null);
  const runStepNow = async (repoId: string, mode: 'quick' | 'full') => {
    setRunningKey(`${repoId}:${mode}`);
    try {
      const result = await scratchApiClient.devTools.runGitMaintenanceStep(repoId, mode);
      const ok = result.state === 'completed' || result.state === 'started';
      notifications.show({
        title: `${mode} GC · ${result.state}`,
        message:
          result.state === 'started'
            ? `${repoId}: still running in the background — watch the Runs tab.`
            : result.state === 'skipped_already_running'
              ? `${repoId}: a GC already holds this repo (loop, manual, or the other container).`
              : `${repoId}: loose ${result.outcome?.before.loose} → ${result.outcome?.after.loose}, packs ${result.outcome?.before.packs} → ${result.outcome?.after.packs}`,
        color: ok ? 'green' : 'red',
      });
      await refresh();
    } catch (e) {
      notifications.show({ title: 'Error', message: `Failed to run ${mode} GC: ${String(e)}`, color: 'red' });
    } finally {
      setRunningKey(null);
    }
  };

  const lastTick = status?.lastTick ?? null;

  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <Stack gap={2}>
            <Text fw={600}>scratch-git background maintenance</Text>
            <Text size="xs" c="dimmed">
              When on, scratch-git scans every repo each minute and runs a <Code>quick</Code> step (pack loose objects,
              roll up packs — deletes nothing) at most hourly, and a <Code>full</Code> <Code>git gc</Code> at most daily
              and only when the pack layout warrants it. When off, jobs run <Code>git gc</Code> after each pull/sync as
              before. The switch and the journal live in a throw-away SQLite file on the git VM; what each repo needs is
              derived from git&apos;s own files (commit-graph, packs), never stored.
            </Text>
          </Stack>
          <Group gap="sm">
            <Button
              variant="default"
              size="xs"
              leftSection={<RefreshCwIcon size={14} />}
              onClick={() => void refresh()}
            >
              Refresh
            </Button>
            {isLoading && !config ? (
              <Loader size="sm" />
            ) : (
              <Switch
                checked={config?.enabled ?? false}
                disabled={isSaving || !!error}
                onChange={(event) => void handleToggle(event.currentTarget.checked)}
                label={config?.enabled ? 'On' : 'Off'}
              />
            )}
          </Group>
        </Group>

        {error && (
          <Alert variant="light" color="red" icon={<InfoIcon size={16} />}>
            Could not reach scratch-git: {error.message}
          </Alert>
        )}

        {config && (
          <Text size="xs" c="dimmed">
            Switch last changed: {config.updatedAtMs ? new Date(config.updatedAtMs).toLocaleString() : '—'}
            {status?.dbPath ? (
              <>
                {' · journal '}
                <Code>{status.dbPath}</Code>
              </>
            ) : null}
          </Text>
        )}

        {status && (
          <Group gap="xs">
            <Badge variant="light" color={status.tickInProgress ? 'blue' : 'gray'}>
              {status.tickInProgress ? 'tick running' : 'idle'}
            </Badge>
            {status.current && (
              <Badge variant="light" color="blue">
                {status.current.mode} · {status.current.repoId} · since{' '}
                {new Date(status.current.startedAtMs).toLocaleTimeString()}
              </Badge>
            )}
            <Badge variant="outline" color="gray">
              quick ≥ {status.settings.looseThreshold} loose or &gt; {status.settings.maxPacks} packs · ≤ 1 /{' '}
              {Math.round(status.settings.quickMinIntervalMs / 3_600_000)} h
            </Badge>
            <Badge variant="outline" color="gray">
              full ≤ 1 / {Math.round(status.settings.fullMinIntervalMs / 3_600_000)} h · share ≥{' '}
              {status.settings.smallPackShareThreshold} · floor{' '}
              {Math.round(status.settings.fullMaxIntervalMs / 86_400_000)} d
            </Badge>
            {lastTick && (
              <Badge variant="outline" color="gray">
                last tick {new Date(lastTick.startedAtMs).toLocaleTimeString()} · {lastTick.reposScanned} repos · ran{' '}
                {lastTick.ran.length}
                {lastTick.reposUnreadable > 0 ? ` · ${lastTick.reposUnreadable} unreadable` : ''}
              </Badge>
            )}
          </Group>
        )}

        <Tabs value={tab} onChange={(value) => setTab((value as PanelTab | null) ?? 'repos')}>
          <Tabs.List>
            <Tabs.Tab value="repos">Repos ({repos.length})</Tabs.Tab>
            <Tabs.Tab value="runs">Runs ({runs.length})</Tabs.Tab>
            <Tabs.Tab value="ticks">Ticks ({ticks.length})</Tabs.Tab>
            <Tabs.Tab value="settings">Settings ({settings.length})</Tabs.Tab>
          </Tabs.List>

          <Tabs.Panel value="repos" pt="sm">
            <Text size="xs" c="dimmed" mb="xs">
              Every repo as the sweep sees it now — counts from <Code>objects/</Code>, last full from{' '}
              <Code>objects/info/commit-graph</Code>, last quick from the newest pack, and what the next tick would do.
            </Text>
            <ReposTable rows={repos} onShowRuns={showRunsFor} onRunStep={runStepNow} runningKey={runningKey} />
          </Tabs.Panel>

          <Tabs.Panel value="runs" pt="sm">
            <Group gap="sm" mb="xs">
              <TextInput
                size="xs"
                w={420}
                placeholder="filter by repo id (org/wkb/coa) — empty = all repos"
                value={runsRepo ?? ''}
                onChange={(event) => setRunsRepo(event.currentTarget.value.trim() || null)}
              />
              <Text size="xs" c="dimmed">
                Journal of every quick/full step, newest first, 30-day retention.
              </Text>
            </Group>
            <RunsTable rows={runs} />
          </Tabs.Panel>

          <Tabs.Panel value="ticks" pt="sm">
            <TicksTable rows={ticks} />
          </Tabs.Panel>

          <Tabs.Panel value="settings" pt="sm">
            <SettingsTable rows={settings} />
          </Tabs.Panel>
        </Tabs>
      </Stack>
    </Paper>
  );
}

function EmptyRow({ colSpan, text }: { colSpan: number; text: string }) {
  return (
    <Table.Tr>
      <Table.Td colSpan={colSpan}>
        <Text c="dimmed" ta="center" size="xs">
          {text}
        </Text>
      </Table.Td>
    </Table.Tr>
  );
}

function ReposTable({
  rows,
  onShowRuns,
  onRunStep,
  runningKey,
}: {
  rows: GitMaintenanceRepoRow[];
  onShowRuns: (repoId: string) => void;
  onRunStep: (repoId: string, mode: 'quick' | 'full') => Promise<void>;
  runningKey: string | null;
}) {
  return (
    <Table highlightOnHover withTableBorder verticalSpacing="sm">
      <Table.Thead>
        <Table.Tr>
          <Th label="Repo" help={HELP.repo} />
          <Th label="User" help={HELP.user} />
          <Th label="Created" help={HELP.created} />
          <Th label="Objects" help={HELP.objects} />
          <Th label="Last write" help={HELP.lastWrite} />
          <Th label="Last quick" help={HELP.lastQuick} />
          <Th label="Last full" help={HELP.lastFull} />
          <Th label="Next tick" help={HELP.nextTick} />
          <Table.Th />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((row) => (
          <Table.Tr key={row.repoId}>
            <Table.Td>
              <RepoId repoId={row.repoId} />
              {row.error && (
                <Text size="xs" c="red">
                  {row.error}
                </Text>
              )}
            </Table.Td>
            <Table.Td>
              <Stack gap={0}>
                <Text size="xs">{row.userName ?? '—'}</Text>
                <Text size="xs" c="dimmed">
                  {row.userEmail ?? ''}
                </Text>
              </Stack>
            </Table.Td>
            <Table.Td>
              <When ms={row.createdAtMs} />
            </Table.Td>
            <Table.Td>
              <ObjectsCell row={row} />
            </Table.Td>
            <Table.Td>
              <When ms={row.lastWriteAtMs} />
            </Table.Td>
            <Table.Td>
              <When ms={row.lastQuickAtMs} />
            </Table.Td>
            <Table.Td>
              <When ms={row.lastFullAtMs} />
            </Table.Td>
            <Table.Td>
              <Stack gap={2} align="flex-start">
                <Badge variant="light" color={planColor(row.plan)}>
                  {row.plan}
                </Badge>
                {row.reason && (
                  <Text size="xs" c="dimmed">
                    {row.reason}
                  </Text>
                )}
              </Stack>
            </Table.Td>
            <Table.Td>
              <Group gap={4} wrap="nowrap">
                <Tooltip label="View this repo's runs in the journal" withArrow>
                  <ActionIcon variant="subtle" color="gray" onClick={() => onShowRuns(row.repoId)}>
                    <EyeIcon size={15} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Run a QUICK step now (pack loose + roll up packs; deletes nothing)" withArrow>
                  <ActionIcon
                    variant="subtle"
                    color="blue"
                    loading={runningKey === `${row.repoId}:quick`}
                    disabled={runningKey !== null && runningKey !== `${row.repoId}:quick`}
                    onClick={() => void onRunStep(row.repoId, 'quick')}
                  >
                    <PlayIcon size={15} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Run a FULL git gc now (one pack, prune with 1 h grace, fsck)" withArrow>
                  <ActionIcon
                    variant="subtle"
                    color="orange"
                    loading={runningKey === `${row.repoId}:full`}
                    disabled={runningKey !== null && runningKey !== `${row.repoId}:full`}
                    onClick={() => void onRunStep(row.repoId, 'full')}
                  >
                    <FastForwardIcon size={15} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            </Table.Td>
          </Table.Tr>
        ))}
        {rows.length === 0 && <EmptyRow colSpan={9} text="No repos found under the repos directory." />}
      </Table.Tbody>
    </Table>
  );
}

function RunsTable({ rows }: { rows: GitMaintenanceRun[] }) {
  return (
    <Table highlightOnHover withTableBorder verticalSpacing="sm">
      <Table.Thead>
        <Table.Tr>
          <Th label="Repo" help={HELP.repo} />
          <Th label="When" help={HELP.runWhen} />
          <Th label="Mode" help={HELP.runMode} />
          <Th label="State" help={HELP.runState} />
          <Th label="Loose" help={HELP.runLoose} />
          <Th label="Packs" help={HELP.runPacks} />
          <Th label="Packed bytes" help={HELP.runPackedBytes} />
          <Th label="Duration" help={HELP.runDuration} />
          <Th label="Commands" help={HELP.runCommands} />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map(({ id, repoId, outcome }) => (
          <Table.Tr key={id}>
            <Table.Td>
              <RepoId repoId={repoId} />
            </Table.Td>
            <Table.Td>
              <When ms={outcome.startedAtMs} />
            </Table.Td>
            <Table.Td>
              <Stack gap={2} align="flex-start">
                <Badge variant="light" color={outcome.mode === 'full' ? 'orange' : 'blue'}>
                  {outcome.mode}
                </Badge>
                <Text size="xs" c="dimmed">
                  {outcome.reason}
                </Text>
              </Stack>
            </Table.Td>
            <Table.Td>
              <Stack gap={2} align="flex-start">
                <Badge variant="light" color={stateColor(outcome)}>
                  {outcome.state}
                </Badge>
                {outcome.fsckClean !== undefined && (
                  <Text size="xs" c={outcome.fsckClean ? 'dimmed' : 'red'}>
                    {outcome.fsckClean ? 'fsck ok' : 'fsck DIRTY'}
                  </Text>
                )}
                {outcome.stderr && (
                  <Text size="xs" c="red">
                    {outcome.stderr}
                  </Text>
                )}
              </Stack>
            </Table.Td>
            <Table.Td>
              <BeforeAfter before={String(outcome.before.loose)} after={String(outcome.after.loose)} />
            </Table.Td>
            <Table.Td>
              <BeforeAfter before={String(outcome.before.packs)} after={String(outcome.after.packs)} />
            </Table.Td>
            <Table.Td>
              <BeforeAfter
                before={formatBytes(outcome.before.packBytes)}
                after={formatBytes(outcome.after.packBytes)}
              />
            </Table.Td>
            <Table.Td>{formatMs(outcome.durationMs)}</Table.Td>
            <Table.Td>
              <Stack gap={0}>
                {outcome.commands.map((command, index) => (
                  <Code key={index}>{command}</Code>
                ))}
              </Stack>
            </Table.Td>
          </Table.Tr>
        ))}
        {rows.length === 0 && <EmptyRow colSpan={9} text="No runs journaled yet." />}
      </Table.Tbody>
    </Table>
  );
}

function TicksTable({ rows }: { rows: GitMaintenanceTickRow[] }) {
  return (
    <Table highlightOnHover withTableBorder verticalSpacing="sm">
      <Table.Thead>
        <Table.Tr>
          <Th label="Started" help={HELP.tickStarted} />
          <Th label="Duration" help={HELP.tickDuration} />
          <Th label="Repos" help={HELP.tickRepos} />
          <Th label="Due" help={HELP.tickDue} />
          <Th label="Ran" help={HELP.tickRan} />
          <Th label="Aborted" help={HELP.tickAborted} />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((row) => (
          <Table.Tr key={row.id}>
            <Table.Td>
              <When ms={row.startedAtMs} />
            </Table.Td>
            <Table.Td>
              <Stack gap={0}>
                <Text size="sm">{formatMs(row.durationMs)}</Text>
                <Text size="xs" c="dimmed">
                  scan {formatMs(row.scanMs)}
                </Text>
              </Stack>
            </Table.Td>
            <Table.Td>
              <Stack gap={0}>
                <Text size="sm">{row.reposScanned}</Text>
                <Text size="xs" c={row.reposUnreadable > 0 ? 'red' : 'dimmed'}>
                  {row.reposUnreadable} unreadable
                </Text>
              </Stack>
            </Table.Td>
            <Table.Td>
              <Stack gap={0}>
                <Text size="sm">quick {row.dueQuick}</Text>
                <Text size="sm">full {row.dueFull}</Text>
              </Stack>
            </Table.Td>
            <Table.Td>{row.ran}</Table.Td>
            <Table.Td>{row.aborted ? 'yes' : ''}</Table.Td>
          </Table.Tr>
        ))}
        {rows.length === 0 && (
          <EmptyRow colSpan={6} text="No ticks journaled yet (the loop only journals while the switch is on)." />
        )}
      </Table.Tbody>
    </Table>
  );
}

function SettingsTable({ rows }: { rows: GitMaintenanceSettingRow[] }) {
  return (
    <Table withTableBorder verticalSpacing="sm">
      <Table.Thead>
        <Table.Tr>
          <Th label="Key" help={HELP.settingKey} />
          <Th label="Value" help={HELP.settingValue} />
          <Th label="Updated" help={HELP.settingUpdated} />
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((row) => (
          <Table.Tr key={row.key}>
            <Table.Td>
              <Code>{row.key}</Code>
            </Table.Td>
            <Table.Td>
              <Code>{row.value}</Code>
            </Table.Td>
            <Table.Td>
              <When ms={row.updatedAtMs} />
            </Table.Td>
          </Table.Tr>
        ))}
        {rows.length === 0 && (
          <EmptyRow colSpan={3} text="No settings rows — the switch has never been flipped (default off)." />
        )}
      </Table.Tbody>
    </Table>
  );
}
