import { formatRecordJson } from '@spinner/shared-types/format';
import type { Dirent } from 'fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'fs/promises';
import { join } from 'path';
import type { ValidatorConfig, ValidatorConfigEntry } from '../shared/validation-types';

const SCRATCH_DIR = '.scratch';
const CONNECTIONS_DIR = join(SCRATCH_DIR, 'connections', 'scratch');
const VALIDATION_FILENAME = 'validation.json';

/**
 * Walk `.scratch/connections/scratch/<connection>/[subfolder/...]` looking for
 * `validation.json` files. Returns a `ValidatorConfig[]` with one entry per
 * file found.
 */
export async function getValidationConfigs(workspacePath: string): Promise<ValidatorConfig[]> {
  const connectionsRoot = join(workspacePath, CONNECTIONS_DIR);
  const configs: ValidatorConfig[] = [];

  let connectionDirs: string[];
  try {
    const entries = await readdir(connectionsRoot, { withFileTypes: true });
    connectionDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  for (const connection of connectionDirs) {
    await walkForValidation(connectionsRoot, connection, '', configs);
  }

  return configs;
}

async function walkForValidation(
  connectionsRoot: string,
  connection: string,
  subPath: string,
  configs: ValidatorConfig[],
): Promise<void> {
  const dirPath = subPath ? join(connectionsRoot, connection, subPath) : join(connectionsRoot, connection);

  let entries: Dirent[];
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isFile() && entry.name === VALIDATION_FILENAME) {
      const filePath = join(dirPath, VALIDATION_FILENAME);
      try {
        const raw = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw) as ValidatorConfigEntry[];
        configs.push({
          connection,
          folderPath: subPath,
          configFilePath: join(CONNECTIONS_DIR, connection, subPath, VALIDATION_FILENAME).replace(/\\/g, '/'),
          entries: Array.isArray(parsed) ? parsed : [],
        });
      } catch {
        // Skip files that can't be parsed
      }
    } else if (entry.isDirectory()) {
      const nextSub = subPath ? `${subPath}/${String(entry.name)}` : String(entry.name);
      await walkForValidation(connectionsRoot, connection, nextSub, configs);
    }
  }
}

/**
 * Write (or overwrite) a `validation.json` for a specific connection + folder.
 * Creates parent directories if needed.
 */
export async function writeValidationConfig(
  workspacePath: string,
  connection: string,
  folderPath: string,
  entries: ValidatorConfigEntry[],
): Promise<void> {
  const dir = folderPath
    ? join(workspacePath, CONNECTIONS_DIR, connection, folderPath)
    : join(workspacePath, CONNECTIONS_DIR, connection);

  // Ensure the connection directory exists before writing
  try {
    await stat(dir);
  } catch {
    await mkdir(dir, { recursive: true });
  }

  const filePath = join(dir, VALIDATION_FILENAME);
  await writeFile(filePath, formatRecordJson(entries), 'utf8');
}

// ---------------------------------------------------------------------------
// Auto-seeding the always-applied validators (DEV-10453, DEV-11238)
// ---------------------------------------------------------------------------

/**
 * The record-scoped schema validator we auto-seed into every folder. `enforce_schema` validates each
 * record against its folder schema; its read-only check (an `x-scratch-readonly` field changed vs the
 * published `master` value) is what surfaces a read-only edit to the user as an advisory warning — the
 * "bubble it up earlier" behavior that replaces silently stripping read-only fields on publish.
 */
const AUTO_SEEDED_ENFORCE_SCHEMA_ENTRY: ValidatorConfigEntry = {
  validator: 'enforce_schema',
  note: 'Auto-seeded by Scratch Desktop — validates each record against its folder schema (advisory).',
};

/**
 * Checks that every `@/…` pseudo-reference in a record is workspace-absolute — that its first path
 * segment names one of the workspace's connection folders (see `docs/pseudo-refs.md`). The publish
 * resolver accepts that form and nothing else, so a reference that omits its connection folder is a
 * guaranteed publish failure; seeding this makes the user see it while editing instead.
 */
const AUTO_SEEDED_PSEUDO_REF_FORMAT_ENTRY: ValidatorConfigEntry = {
  validator: 'pseudo_ref_format',
  note: 'Auto-seeded by Scratch Desktop — checks that @/ references are workspace-absolute.',
};

/**
 * The validators Scratch Desktop always applies, in seed order. "Always applied" means a folder
 * missing any of them is re-seeded on the next workspace load, so removing one via the Validation UI
 * does not stick — see {@link ensureAutoSeededValidatorsInEveryFolder}.
 */
const AUTO_SEEDED_VALIDATOR_ENTRIES: ValidatorConfigEntry[] = [
  AUTO_SEEDED_ENFORCE_SCHEMA_ENTRY,
  AUTO_SEEDED_PSEUDO_REF_FORMAT_ENTRY,
];

/**
 * Split a workspace-relative leaf-folder name (e.g. `pipedrive/Deals`) into its connection dir name and
 * connection-relative folder path — the `(connection, folderPath)` shape `writeValidationConfig` expects.
 */
function splitLeafFolderName(leafFolderName: string): { connectionDirName: string; folderPath: string } {
  const firstSlashIndex = leafFolderName.indexOf('/');
  if (firstSlashIndex === -1) return { connectionDirName: leafFolderName, folderPath: '' };
  return {
    connectionDirName: leafFolderName.slice(0, firstSlashIndex),
    folderPath: leafFolderName.slice(firstSlashIndex + 1),
  };
}

/**
 * Decide which leaf folders are still missing one of {@link AUTO_SEEDED_VALIDATOR_ENTRIES}, and the
 * full entry list to write for each. Pure (no I/O) so it is unit-testable. A folder that already has
 * every auto-seeded validator is skipped (idempotent); otherwise only the MISSING ones are appended,
 * after any existing user validators, preserving their order.
 */
export function computeFoldersNeedingAutoSeededValidators(
  leafFolderNames: string[],
  existingConfigs: ValidatorConfig[],
): Array<{ connectionDirName: string; folderPath: string; entriesToWrite: ValidatorConfigEntry[] }> {
  const existingEntriesByConnectionAndFolderPath = new Map<string, ValidatorConfigEntry[]>(
    existingConfigs.map((config) => [`${config.connection}/${config.folderPath}`, config.entries]),
  );

  const foldersToSeed: Array<{
    connectionDirName: string;
    folderPath: string;
    entriesToWrite: ValidatorConfigEntry[];
  }> = [];

  for (const leafFolderName of leafFolderNames) {
    const { connectionDirName, folderPath } = splitLeafFolderName(leafFolderName);
    if (!connectionDirName) continue;

    const existingEntries = existingEntriesByConnectionAndFolderPath.get(`${connectionDirName}/${folderPath}`) ?? [];
    const missingEntries = AUTO_SEEDED_VALIDATOR_ENTRIES.filter(
      (autoSeeded) => !existingEntries.some((entry) => entry.validator === autoSeeded.validator),
    );
    if (missingEntries.length === 0) continue;

    foldersToSeed.push({
      connectionDirName,
      folderPath,
      entriesToWrite: [...existingEntries, ...missingEntries],
    });
  }

  return foldersToSeed;
}

/**
 * Ensure every data leaf folder in the workspace carries each of {@link AUTO_SEEDED_VALIDATOR_ENTRIES}
 * — `enforce_schema`, so schema validation (and its read-only-edit warning) always runs, and
 * `pseudo_ref_format`, so a malformed `@/…` reference surfaces at edit time rather than at publish.
 * Idempotent and order-preserving (see {@link computeFoldersNeedingAutoSeededValidators}). Writes only
 * under `.scratch/`, which is excluded from the publish/review diff, so it never blocks publish or
 * pollutes the user's record diff. Best-effort — callers should swallow/log errors.
 *
 * Note: a folder whose entry was removed via the Validation UI is re-seeded on the next workspace load
 * (the rule is "always applied"); deliberate removal is not currently honored.
 *
 * @returns the (connectionDirName, folderPath) pairs newly seeded this run.
 */
export async function ensureAutoSeededValidatorsInEveryFolder(
  workspacePath: string,
): Promise<Array<{ connectionDirName: string; folderPath: string }>> {
  // Imported dynamically so this module (and its unit tests) don't pull in the heavier local-files /
  // native dependency graph at load time.
  const { listFolders } = await import('./local-files');
  const [leafFolders, existingConfigs] = await Promise.all([
    listFolders(workspacePath),
    getValidationConfigs(workspacePath),
  ]);

  const foldersToSeed = computeFoldersNeedingAutoSeededValidators(
    leafFolders.map((folder) => folder.name),
    existingConfigs,
  );

  for (const { connectionDirName, folderPath, entriesToWrite } of foldersToSeed) {
    await writeValidationConfig(workspacePath, connectionDirName, folderPath, entriesToWrite);
  }

  return foldersToSeed.map(({ connectionDirName, folderPath }) => ({ connectionDirName, folderPath }));
}
