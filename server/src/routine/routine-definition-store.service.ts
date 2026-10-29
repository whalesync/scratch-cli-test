import { Injectable, NotFoundException } from '@nestjs/common';
import { RoutineDefinition as PrismaRoutineDefinition } from '@prisma/client';
import {
  createRoutineDefinitionId,
  PushRoutineStaleFileDto,
  RoutineFileVersion,
  WorkbookId,
} from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { MAIN_BRANCH, ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { getWorkbookRepoPath } from 'src/workbook/workbook-repo.service';
import { assertValidRoutineFilePath, ROUTINES_DIRECTORY } from './routine-file-path';

/** Where a routine definition's current content came from (`RoutineDefinition.source`). */
export type RoutineDefinitionSource = 'web' | 'cli' | 'generated' | 'git-import';

/** What {@link RoutineDefinitionStoreService.upsertDefinition} did with the row. */
export type RoutineDefinitionWriteOutcome = 'created' | 'updated' | 'unchanged';

/** One routine file to create or overwrite in a batch push, with its optional per-file staleness guard. */
export interface RoutineDefinitionPushUpsert {
  filePath: string;
  content: string;
  /** The version the client last saw; `null` = "expect new"; `undefined` = no guard for this file. */
  baseVersion: number | null | undefined;
}

/** One routine file to delete in a batch push, with its optional per-file staleness guard. */
export interface RoutineDefinitionPushDelete {
  filePath: string;
  baseVersion: number | null | undefined;
}

export type RoutineDefinitionPushResult =
  | { status: 'applied'; files: RoutineFileVersion[]; upsertedFilePaths: string[]; deletedFilePaths: string[] }
  | { status: 'blocked_stale'; staleFiles: PushRoutineStaleFileDto[] };

/** Outcome of one workbook's one-time import of `routines/*.yaml` from its config git repo. */
export interface RoutineGitImportOutcome {
  /** False when the workbook's flag was already clear — nothing was read from git. */
  attempted: boolean;
  /**
   * True when the routines listing was empty AND scratch-git reports no such repo. The flag is
   * left SET in that case: an absent repo on the git host we are talking to cannot prove the
   * workbook has no routines (a misrouted or partially-restored git host looks exactly like this),
   * so the import is retried on the next read instead of silently finishing with nothing.
   */
  configRepoMissing: boolean;
  imported: number;
  /** Git files whose path already had a row (a user wrote it after the flag was set) — the row wins. */
  skippedExisting: number;
  /** Git files whose path fails the routine path rules — never importable, logged and left in git. */
  skippedInvalid: number;
}

/**
 * The single owner of routine *definitions*: the `RoutineDefinition` table, plus the one-time
 * import of `routines/*.yaml` from the workbook config git repo for workbooks that predate the
 * table (DEV-11399). Every reader of a routine's YAML — the REST list/get/edit endpoints, the CLI
 * push, the executor's `triggerRun`, the scheduler — goes through here, so "Postgres is the source
 * of truth, git is a one-shot fallback" is enforced in exactly one place.
 *
 * The fallback is deliberately NOT a perpetual "read git when the row is missing": that would
 * resurrect every deleted routine from git. Instead `Workbook.routinesPendingGitImport` is true
 * exactly once per pre-existing workbook; the first read copies git into rows (rows win on
 * conflict) and clears the flag, after which git is never consulted for definitions again.
 */
@Injectable()
export class RoutineDefinitionStoreService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
  ) {}

  /** Every routine definition of the workbook, ordered by file path. Runs the one-time git import first. */
  async listDefinitions(workbookId: WorkbookId): Promise<PrismaRoutineDefinition[]> {
    await this.ensureImportedFromGit(workbookId);
    return this.db.client.routineDefinition.findMany({ where: { workbookId }, orderBy: { filePath: 'asc' } });
  }

  /**
   * One routine definition by file path, or `null` when it does not exist. Runs the one-time git
   * import first; after that a missing row is authoritative (never falls back to git per path).
   */
  async getDefinition(workbookId: WorkbookId, filePath: string): Promise<PrismaRoutineDefinition | null> {
    await this.ensureImportedFromGit(workbookId);
    return this.db.client.routineDefinition.findUnique({
      where: { workbookId_filePath: { workbookId, filePath } },
    });
  }

  /**
   * Creates the row when absent, replaces its content (bumping `version`) when it differs, and
   * leaves it untouched when the stored content is byte-identical. Callers validate the YAML and
   * its references BEFORE calling this — the store never parses.
   */
  async upsertDefinition(
    workbookId: WorkbookId,
    filePath: string,
    content: string,
    options: { source: RoutineDefinitionSource; updatedByUserId: string | null },
  ): Promise<{ definition: PrismaRoutineDefinition; outcome: RoutineDefinitionWriteOutcome }> {
    assertValidRoutineFilePath(filePath);
    const existing = await this.getDefinition(workbookId, filePath);
    if (existing === null) {
      const definition = await this.db.client.routineDefinition.create({
        data: {
          id: createRoutineDefinitionId(),
          workbookId,
          filePath,
          content,
          source: options.source,
          updatedByUserId: options.updatedByUserId,
        },
      });
      return { definition, outcome: 'created' };
    }
    if (existing.content === content) {
      return { definition: existing, outcome: 'unchanged' };
    }
    const definition = await this.db.client.routineDefinition.update({
      where: { id: existing.id },
      data: {
        content,
        version: { increment: 1 },
        source: options.source,
        updatedByUserId: options.updatedByUserId,
      },
    });
    return { definition, outcome: 'updated' };
  }

  /** Deletes the row. Returns false (and does nothing) when it does not exist. */
  async deleteDefinition(workbookId: WorkbookId, filePath: string): Promise<boolean> {
    await this.ensureImportedFromGit(workbookId);
    const deleted = await this.db.client.routineDefinition.deleteMany({ where: { workbookId, filePath } });
    return deleted.count === 1;
  }

  /**
   * Applies a batch of upserts + deletes atomically, under a per-workbook advisory lock so two
   * concurrent pushes serialize. Every file's `baseVersion` (when given) is compared against the
   * current row FIRST; if any is stale the transaction rolls back having written nothing and the
   * stale files are reported. Deleting an absent path is a no-op. An upsert whose content is
   * byte-identical to the row is skipped (no version bump), so re-pushing converges.
   *
   * The caller must have validated every upsert (parse + references) and run
   * {@link ensureImportedFromGit} before calling — the import does its own writes and must not
   * nest inside this transaction.
   */
  async applyPush(
    workbookId: WorkbookId,
    push: {
      upserts: RoutineDefinitionPushUpsert[];
      deletes: RoutineDefinitionPushDelete[];
      source: RoutineDefinitionSource;
      updatedByUserId: string | null;
    },
  ): Promise<RoutineDefinitionPushResult> {
    await this.ensureImportedFromGit(workbookId);

    return this.db.client.$transaction(async (tx) => {
      const lockKey = `routines:${workbookId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`;

      const currentRows = await tx.routineDefinition.findMany({ where: { workbookId } });
      const currentRowByFilePath = new Map(currentRows.map((row) => [row.filePath, row]));

      const staleFiles: PushRoutineStaleFileDto[] = [];
      for (const upsert of push.upserts) {
        const current = currentRowByFilePath.get(upsert.filePath);
        if (isBaseVersionStale(upsert.baseVersion, current?.version ?? null)) {
          staleFiles.push({
            path: upsert.filePath,
            baseVersion: upsert.baseVersion ?? null,
            currentVersion: current?.version ?? null,
          });
        }
      }
      for (const deletion of push.deletes) {
        const current = currentRowByFilePath.get(deletion.filePath);
        // Deleting an already-absent path is a no-op regardless of what the client thought it had.
        if (current !== undefined && isBaseVersionStale(deletion.baseVersion, current.version)) {
          staleFiles.push({
            path: deletion.filePath,
            baseVersion: deletion.baseVersion ?? null,
            currentVersion: current.version,
          });
        }
      }
      if (staleFiles.length > 0) {
        return { status: 'blocked_stale', staleFiles };
      }

      const upsertedFilePaths: string[] = [];
      for (const upsert of push.upserts) {
        const current = currentRowByFilePath.get(upsert.filePath);
        if (current === undefined) {
          await tx.routineDefinition.create({
            data: {
              id: createRoutineDefinitionId(),
              workbookId,
              filePath: upsert.filePath,
              content: upsert.content,
              source: push.source,
              updatedByUserId: push.updatedByUserId,
            },
          });
          upsertedFilePaths.push(upsert.filePath);
        } else if (current.content !== upsert.content) {
          await tx.routineDefinition.update({
            where: { id: current.id },
            data: {
              content: upsert.content,
              version: { increment: 1 },
              source: push.source,
              updatedByUserId: push.updatedByUserId,
            },
          });
          upsertedFilePaths.push(upsert.filePath);
        }
      }

      const deletedFilePaths = push.deletes
        .map((deletion) => deletion.filePath)
        .filter((filePath) => currentRowByFilePath.has(filePath));
      if (deletedFilePaths.length > 0) {
        await tx.routineDefinition.deleteMany({ where: { workbookId, filePath: { in: deletedFilePaths } } });
      }

      const rowsAfterPush = await tx.routineDefinition.findMany({
        where: { workbookId },
        orderBy: { filePath: 'asc' },
        select: { filePath: true, version: true },
      });
      return {
        status: 'applied',
        files: rowsAfterPush.map((row) => ({ path: row.filePath, version: row.version })),
        upsertedFilePaths,
        deletedFilePaths,
      };
    });
  }

  /**
   * The one-shot git fallback. When `Workbook.routinesPendingGitImport` is set, copies every
   * `routines/*.yaml` of the config repo into `RoutineDefinition` rows (`source: 'git-import'`,
   * `skipDuplicates` so a row a user wrote meanwhile wins and two racing imports both converge),
   * then clears the flag. A cleared flag returns immediately with no git access.
   *
   * Throws — rather than importing a partial set — when scratch-git fails for any reason other
   * than "folder does not exist". A partial import would let `reloadRoutines` orphan-clean the
   * schedules of routines that merely failed to load; a thrown error leaves the flag set so the
   * next read retries. An empty listing clears the flag only once scratch-git confirms the repo
   * exists (see {@link RoutineGitImportOutcome.configRepoMissing}).
   */
  async ensureImportedFromGit(workbookId: WorkbookId): Promise<RoutineGitImportOutcome> {
    const workbook = await this.db.client.workbook.findFirst({
      where: { id: workbookId },
      select: { organizationId: true, routinesPendingGitImport: true },
    });
    if (!workbook) {
      throw new NotFoundException(`Workbook ${workbookId} not found`);
    }
    if (!workbook.routinesPendingGitImport) {
      return { attempted: false, configRepoMissing: false, imported: 0, skippedExisting: 0, skippedInvalid: 0 };
    }

    const repoId = getWorkbookRepoPath(workbook.organizationId, workbookId);
    const gitFiles = await this.readRoutineFilesFromGit(repoId);

    // An empty listing is ambiguous: scratch-git answers `[]` both for "no routines/ folder" and for
    // "no such repo" (its 404 is mapped to an empty list). Only the first may clear the flag — the
    // second means we are not looking at this workbook's repo at all (wrong git host, repo not yet
    // restored), and clearing the flag would silently lose every routine it holds. Same guard as
    // the fileindex code migrations' "prove the repo is readable before an empty listing counts".
    if (gitFiles.length === 0) {
      const { exists } = await this.scratchGitService.repoExists(repoId);
      if (!exists) {
        WSLogger.warn({
          source: 'RoutineDefinitionStoreService.ensureImportedFromGit',
          message: `Config repo ${repoId} does not exist on the git host; leaving routinesPendingGitImport set`,
          workbookId,
        });
        return { attempted: true, configRepoMissing: true, imported: 0, skippedExisting: 0, skippedInvalid: 0 };
      }
    }

    const importableFiles: { filePath: string; content: string }[] = [];
    let skippedInvalid = 0;
    for (const gitFile of gitFiles) {
      try {
        assertValidRoutineFilePath(gitFile.path);
      } catch (error) {
        skippedInvalid += 1;
        WSLogger.warn({
          source: 'RoutineDefinitionStoreService.ensureImportedFromGit',
          message: `Skipping routine file ${gitFile.path} in git: not a valid routine path`,
          workbookId,
          error,
        });
        continue;
      }
      importableFiles.push({ filePath: gitFile.path, content: gitFile.content });
    }

    let imported = 0;
    if (importableFiles.length > 0) {
      const created = await this.db.client.routineDefinition.createMany({
        data: importableFiles.map((file) => ({
          id: createRoutineDefinitionId(),
          workbookId,
          filePath: file.filePath,
          content: file.content,
          source: 'git-import' satisfies RoutineDefinitionSource,
          updatedByUserId: null,
        })),
        skipDuplicates: true,
      });
      imported = created.count;
    }
    const skippedExisting = importableFiles.length - imported;

    // Clear the flag only after the rows are in. The guard on the flag keeps a racing import from
    // logging a second "imported" line for a workbook that was already flipped.
    await this.db.client.workbook.updateMany({
      where: { id: workbookId, routinesPendingGitImport: true },
      data: { routinesPendingGitImport: false },
    });

    WSLogger.info({
      source: 'RoutineDefinitionStoreService.ensureImportedFromGit',
      message: `Imported ${imported} routine file(s) from git (${skippedExisting} already in DB, ${skippedInvalid} invalid path(s))`,
      workbookId,
    });
    return { attempted: true, configRepoMissing: false, imported, skippedExisting, skippedInvalid };
  }

  /**
   * Reads every `routines/*.yaml|yml` blob from the config repo `main`. An absent repo or folder
   * is an empty list (scratch-git maps its 404 to `[]`); any other failure propagates.
   */
  async readRoutineFilesFromGit(repoId: string): Promise<{ path: string; content: string }[]> {
    const entries = await this.scratchGitService.listRepoFiles(repoId, MAIN_BRANCH, ROUTINES_DIRECTORY);
    const yamlFilePaths = entries
      .filter((entry) => entry.type === 'file' && (entry.path.endsWith('.yaml') || entry.path.endsWith('.yml')))
      .map((entry) => entry.path);
    if (yamlFilePaths.length === 0) {
      return [];
    }
    const files = await this.scratchGitService.readRepoFiles(repoId, MAIN_BRANCH, yamlFilePaths);
    return files.flatMap((file) =>
      // Listed but unreadable (raced deletion) — skip; nothing to import for that path.
      file.content === null ? [] : [{ path: file.path, content: file.content }],
    );
  }

  /** Resolves the workbook config repo id (`{orgId}/{workbookId}/{workbookId}`). 404 if the workbook is missing. */
  async resolveConfigRepoId(workbookId: WorkbookId): Promise<string> {
    const workbook = await this.db.client.workbook.findFirst({
      where: { id: workbookId },
      select: { organizationId: true },
    });
    if (!workbook) {
      throw new NotFoundException(`Workbook ${workbookId} not found`);
    }
    return getWorkbookRepoPath(workbook.organizationId, workbookId);
  }
}

/**
 * A client's `baseVersion` is stale when it disagrees with the row: it claimed a version the row
 * no longer has, claimed "new" (`null`) but a row exists, or claimed a version but the row is gone.
 * `undefined` means the client sent no guard for this file (pre-DEV-11399 CLI) — never stale.
 */
export function isBaseVersionStale(baseVersion: number | null | undefined, currentVersion: number | null): boolean {
  if (baseVersion === undefined) {
    return false;
  }
  return baseVersion !== currentVersion;
}
