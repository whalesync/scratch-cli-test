import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BuiltinValidatorInfo,
  ValidationResultRow,
  ValidationStat,
  ValidatorConfig,
  ValidatorConfigEntry,
} from '../../../shared/validation-types';
import { useWorkspaceUiStore } from '../stores/workspace-ui-store';

// ---------------------------------------------------------------------------
// Built-in validator catalog (static)
// ---------------------------------------------------------------------------

export const BUILTIN_VALIDATORS: BuiltinValidatorInfo[] = [
  {
    name: 'required',
    description: 'Ensures the field is present and non-empty.',
    scope: 'field',
    paramSchema: null,
  },
  {
    name: 'length',
    description: 'Checks that a string field length is within a range.',
    scope: 'field',
    paramSchema: { min: { type: 'number' }, max: { type: 'number' } },
  },
  {
    name: 'max_length',
    description: 'Checks that a string field does not exceed a maximum length.',
    scope: 'field',
    paramSchema: { max: { type: 'number' } },
  },
  {
    name: 'enforce_schema',
    description: 'Validates that the record conforms to the folder schema definition.',
    scope: 'record',
    paramSchema: null,
  },
];

// ---------------------------------------------------------------------------
// Hook return type
// ---------------------------------------------------------------------------

export interface UseValidationReturn {
  /** All parsed validation.json configs across the workspace. */
  configs: ValidatorConfig[];
  /** Whether configs are currently being loaded. */
  configsLoading: boolean;

  /** Workspace-wide error/warning counts per folder. */
  stats: ValidationStat[];
  /** Whether stats are currently being loaded. */
  statsLoading: boolean;

  /** Static catalog of built-in validators. */
  availableValidators: BuiltinValidatorInfo[];

  /** Whether inline validation is enabled. */
  validateEnabled: boolean;
  /** Toggle inline validation on/off. */
  setValidateEnabled: (enabled: boolean) => void;

  /** Manually re-fetch all validation configs. */
  refreshConfigs: () => void;
  /** Manually re-fetch validation stats. */
  refreshStats: () => void;

  /** Fetch validation errors for a specific folder (on-demand, not cached). */
  getFolderErrors: (folderPath: string) => Promise<ValidationResultRow[]>;

  /** Append a new validator entry to a folder's validation.json. */
  addValidator: (connection: string, folderPath: string, entry: ValidatorConfigEntry) => Promise<void>;
  /** Replace a validator entry by index in a folder's validation.json. */
  updateValidator: (connection: string, folderPath: string, idx: number, entry: ValidatorConfigEntry) => Promise<void>;
  /** Remove a validator entry by index from a folder's validation.json. */
  removeValidator: (connection: string, folderPath: string, idx: number) => Promise<void>;

  /** Look up the ValidatorConfig for a specific connection + folder path. */
  getConfigForFolder: (connection: string, folderPath: string) => ValidatorConfig | undefined;
  /** Get all validators that target a specific field within a folder. */
  getValidatorsForColumn: (connection: string, folderPath: string, fieldName: string) => ValidatorConfigEntry[];
}

// ---------------------------------------------------------------------------
// Hook implementation
// ---------------------------------------------------------------------------

export function useValidation(workspacePath: string | null, refreshKey?: number): UseValidationReturn {
  const [configs, setConfigs] = useState<ValidatorConfig[]>([]);
  const [configsLoading, setConfigsLoading] = useState(false);
  const [stats, setStats] = useState<ValidationStat[]>([]);
  const [statsLoading, setStatsLoading] = useState(false);

  const validateEnabled = useWorkspaceUiStore((s) => s.validateEnabled);
  const setValidateEnabled = useWorkspaceUiStore((s) => s.setValidateEnabled);

  // Generation counter to discard stale responses
  const configGenRef = useRef(0);
  const statsGenRef = useRef(0);

  // ── Load configs ──

  const loadConfigs = useCallback(async () => {
    if (!workspacePath) {
      setConfigs([]);
      return;
    }
    const gen = ++configGenRef.current;
    setConfigsLoading(true);
    try {
      const result = await window.scratchFiles.getValidationConfigs(workspacePath);
      if (gen === configGenRef.current) {
        setConfigs(result);
      }
    } catch (err) {
      console.debug('[useValidation] failed to load configs:', err);
      if (gen === configGenRef.current) {
        setConfigs([]);
      }
    } finally {
      if (gen === configGenRef.current) {
        setConfigsLoading(false);
      }
    }
  }, [workspacePath]);

  // ── Load stats ──

  const loadStats = useCallback(async () => {
    if (!workspacePath) {
      setStats([]);
      return;
    }
    const gen = ++statsGenRef.current;
    setStatsLoading(true);
    try {
      const result = await window.scratchFiles.getValidationStats(workspacePath);
      if (gen === statsGenRef.current) {
        setStats(result);
      }
    } catch (err) {
      console.debug('[useValidation] failed to load stats:', err);
      if (gen === statsGenRef.current) {
        setStats([]);
      }
    } finally {
      if (gen === statsGenRef.current) {
        setStatsLoading(false);
      }
    }
  }, [workspacePath]);

  // Auto-refresh on mount and when refreshKey changes
  useEffect(() => {
    void loadConfigs();
  }, [loadConfigs, refreshKey]);

  useEffect(() => {
    void loadStats();
  }, [loadStats, refreshKey]);

  // ── On-demand folder errors ──

  const getFolderErrors = useCallback(
    async (folderPath: string): Promise<ValidationResultRow[]> => {
      if (!workspacePath) return [];
      return window.scratchFiles.getFolderValidationResults(workspacePath, folderPath);
    },
    [workspacePath],
  );

  // ── Mutation helpers ──

  const findConfig = useCallback(
    (connection: string, folderPath: string): ValidatorConfig | undefined => {
      return configs.find((c) => c.connection === connection && c.folderPath === folderPath);
    },
    [configs],
  );

  const addValidator = useCallback(
    async (connection: string, folderPath: string, entry: ValidatorConfigEntry) => {
      if (!workspacePath) return;
      const existing = findConfig(connection, folderPath);
      const entries = [...(existing?.entries ?? []), entry];
      await window.scratchFiles.writeValidationConfig(workspacePath, connection, folderPath, entries);
      void loadConfigs();
    },
    [workspacePath, findConfig, loadConfigs],
  );

  const updateValidator = useCallback(
    async (connection: string, folderPath: string, idx: number, entry: ValidatorConfigEntry) => {
      if (!workspacePath) return;
      const existing = findConfig(connection, folderPath);
      const entries = [...(existing?.entries ?? [])];
      if (idx >= 0 && idx < entries.length) {
        entries[idx] = entry;
      }
      await window.scratchFiles.writeValidationConfig(workspacePath, connection, folderPath, entries);
      void loadConfigs();
    },
    [workspacePath, findConfig, loadConfigs],
  );

  const removeValidator = useCallback(
    async (connection: string, folderPath: string, idx: number) => {
      if (!workspacePath) return;
      const existing = findConfig(connection, folderPath);
      const entries = [...(existing?.entries ?? [])];
      if (idx >= 0 && idx < entries.length) {
        entries.splice(idx, 1);
      }
      await window.scratchFiles.writeValidationConfig(workspacePath, connection, folderPath, entries);
      void loadConfigs();
    },
    [workspacePath, findConfig, loadConfigs],
  );

  // ── Lookup helpers ──

  const getConfigForFolder = useCallback(
    (connection: string, folderPath: string): ValidatorConfig | undefined => {
      return findConfig(connection, folderPath);
    },
    [findConfig],
  );

  const getValidatorsForColumn = useCallback(
    (connection: string, folderPath: string, fieldName: string): ValidatorConfigEntry[] => {
      const config = findConfig(connection, folderPath);
      if (!config) return [];
      return config.entries.filter((e) => e.field === fieldName || (e.fields && e.fields.includes(fieldName)));
    },
    [findConfig],
  );

  return useMemo(
    () => ({
      configs,
      configsLoading,
      stats,
      statsLoading,
      availableValidators: BUILTIN_VALIDATORS,
      validateEnabled,
      setValidateEnabled,
      refreshConfigs: () => void loadConfigs(),
      refreshStats: () => void loadStats(),
      getFolderErrors,
      addValidator,
      updateValidator,
      removeValidator,
      getConfigForFolder,
      getValidatorsForColumn,
    }),
    [
      configs,
      configsLoading,
      stats,
      statsLoading,
      validateEnabled,
      setValidateEnabled,
      loadConfigs,
      loadStats,
      getFolderErrors,
      addValidator,
      updateValidator,
      removeValidator,
      getConfigForFolder,
      getValidatorsForColumn,
    ],
  );
}
