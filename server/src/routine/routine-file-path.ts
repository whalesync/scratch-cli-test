import { BadRequestException } from '@nestjs/common';

/**
 * Directory in the workbook config repo that holds routine YAML files. Repo-relative with NO
 * trailing slash: scratch-git's tree walk splits the folder on "/", so "routines/" would resolve
 * to a non-existent empty subdir and list nothing. Routine file paths are `${ROUTINES_DIRECTORY}/x.yaml`.
 */
export const ROUTINES_DIRECTORY = 'routines';

/**
 * Guards every routine file read/write/trigger against escaping the `routines/` directory: the path
 * must be a single `.yaml`/`.yml` file directly under `routines/`, with no `..` traversal. This is a
 * security boundary — without it a caller could read, overwrite, or trigger arbitrary config-repo files.
 */
export function assertValidRoutineFilePath(path: string): void {
  if (!path) {
    throw new BadRequestException('routine file path is required');
  }
  const directoryPrefix = `${ROUTINES_DIRECTORY}/`;
  const errorPrefix = `Invalid routine file path "${path}":`;
  if (!path.startsWith(directoryPrefix)) {
    throw new BadRequestException(`${errorPrefix} must be inside "${directoryPrefix}"`);
  }
  if (path.includes('..')) {
    throw new BadRequestException(`${errorPrefix} must not contain ".."`);
  }
  const fileName = path.slice(directoryPrefix.length);
  if (fileName.length === 0 || fileName.includes('/')) {
    throw new BadRequestException(`${errorPrefix} must be a single file directly under "${directoryPrefix}"`);
  }
  if (!fileName.endsWith('.yaml') && !fileName.endsWith('.yml')) {
    throw new BadRequestException(`${errorPrefix} must end with .yaml or .yml`);
  }
}
