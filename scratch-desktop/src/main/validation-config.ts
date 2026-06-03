import { formatRecordJson } from '@spinner/shared-types/format';
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

  let entries: Awaited<ReturnType<typeof readdir>>;
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
