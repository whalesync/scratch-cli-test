import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import {
  GitMaintenanceConfigResponse,
  GitMaintenanceRepoRow,
  GitMaintenanceRun,
  GitMaintenanceSettingRow,
  GitMaintenanceStatusResponse,
  GitMaintenanceTickRow,
} from '@spinner/shared-types';
import { useState } from 'react';
import useSWR from 'swr';

interface UseGitMaintenanceReturn {
  config: GitMaintenanceConfigResponse | undefined;
  status: GitMaintenanceStatusResponse | undefined;
  /** Rows of the maintenance DB's `settings` table. */
  settings: GitMaintenanceSettingRow[];
  /** Every repo with its derived state and what the next tick would do. */
  repos: GitMaintenanceRepoRow[];
  /** The tick journal, newest first. */
  ticks: GitMaintenanceTickRow[];
  /** The run journal, newest first — all repos, or only `runsRepo` when set. */
  runs: GitMaintenanceRun[];
  runsRepo: string | null;
  setRunsRepo: (repo: string | null) => void;
  isLoading: boolean;
  error: Error | undefined;
  /** Flip scratch-git's background-maintenance switch (persisted in the maintenance DB). */
  setEnabled: (enabled: boolean) => Promise<GitMaintenanceConfigResponse>;
  refresh: () => Promise<unknown>;
}

interface UseGitMaintenanceOptions {
  /**
   * Also load the DB tables (repos, runs, ticks, settings). The full GC page wants them; the
   * one-line cron entry only needs the switch and the status, so it passes `false`.
   */
  includeTables?: boolean;
}

const SWR_OPTIONS = { revalidateOnFocus: false } as const;

/**
 * scratch-git's background-maintenance switch, loop status and the maintenance DB tables for the
 * admin dev tools (DEV-11316). Status is polled while the page is open so an in-flight step and the
 * last tick stay current; the tables refresh on demand.
 */
export const useGitMaintenance = (options?: UseGitMaintenanceOptions): UseGitMaintenanceReturn => {
  const includeTables = options?.includeTables ?? true;
  const [runsRepo, setRunsRepo] = useState<string | null>(null);

  const config = useSWR<GitMaintenanceConfigResponse, Error>(
    SWR_KEYS.gitMaintenance.config(),
    () => scratchApiClient.devTools.getGitMaintenanceConfig(),
    SWR_OPTIONS,
  );
  const status = useSWR<GitMaintenanceStatusResponse, Error>(
    SWR_KEYS.gitMaintenance.status(),
    () => scratchApiClient.devTools.getGitMaintenanceStatus(),
    { ...SWR_OPTIONS, refreshInterval: 15_000 },
  );
  const settings = useSWR<GitMaintenanceSettingRow[], Error>(
    includeTables ? SWR_KEYS.gitMaintenance.settings() : null,
    () => scratchApiClient.devTools.getGitMaintenanceSettings(),
    SWR_OPTIONS,
  );
  const repos = useSWR<GitMaintenanceRepoRow[], Error>(
    includeTables ? SWR_KEYS.gitMaintenance.repos() : null,
    () => scratchApiClient.devTools.getGitMaintenanceRepos(),
    SWR_OPTIONS,
  );
  const ticks = useSWR<GitMaintenanceTickRow[], Error>(
    includeTables ? SWR_KEYS.gitMaintenance.ticks() : null,
    () => scratchApiClient.devTools.getGitMaintenanceTicks(50),
    SWR_OPTIONS,
  );
  const runs = useSWR<GitMaintenanceRun[], Error>(
    includeTables ? SWR_KEYS.gitMaintenance.runs(runsRepo) : null,
    () => scratchApiClient.devTools.getGitMaintenanceRuns({ repo: runsRepo ?? undefined, limit: 200 }),
    SWR_OPTIONS,
  );

  const refresh = async () =>
    Promise.all([config.mutate(), status.mutate(), settings.mutate(), repos.mutate(), ticks.mutate(), runs.mutate()]);

  const setEnabled = async (enabled: boolean): Promise<GitMaintenanceConfigResponse> => {
    const updated = await scratchApiClient.devTools.setGitMaintenanceEnabled(enabled);
    await Promise.all([config.mutate(updated, { revalidate: false }), status.mutate(), settings.mutate()]);
    return updated;
  };

  return {
    config: config.data,
    status: status.data,
    settings: settings.data ?? [],
    repos: repos.data ?? [],
    ticks: ticks.data ?? [],
    runs: runs.data ?? [],
    runsRepo,
    setRunsRepo,
    isLoading: config.isLoading || status.isLoading,
    error: config.error ?? status.error ?? settings.error ?? repos.error ?? ticks.error ?? runs.error,
    setEnabled,
    refresh,
  };
};
