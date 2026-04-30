const WORKSPACE_FILE_WATCHER_EXPERIMENT_KEY = 'workspace_file_watcher_experiment_enabled';

export function isWorkspaceFileWatcherExperimentEnabled(): boolean {
  try {
    return localStorage.getItem(WORKSPACE_FILE_WATCHER_EXPERIMENT_KEY) === 'true';
  } catch {
    return false;
  }
}

export function setWorkspaceFileWatcherExperimentEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(WORKSPACE_FILE_WATCHER_EXPERIMENT_KEY, enabled ? 'true' : 'false');
  } catch {
    // Ignore storage failures. The feature simply remains off.
  }
}
