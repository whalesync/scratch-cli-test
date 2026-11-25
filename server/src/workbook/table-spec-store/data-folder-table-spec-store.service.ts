import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { formatRecordJson, type CliTableSpecArtifact, type TableView } from '@spinner/shared-types';
import { createHash } from 'crypto';
import { isEqual, isPlainObject } from 'lodash';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import type { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import {
  ScratchGitBadRequestError,
  ScratchGitIndexBuildRequestBodyTooLargeError,
  ScratchGitRequestEntityTooLargeError,
  type BuildRepoIndexResult,
} from 'src/scratch-git/scratch-git.client';
import {
  repoRelativeFolderKeyForFolderPath,
  ScratchGitService,
  stripGeneratedAt,
} from 'src/scratch-git/scratch-git.service';
import type { TableSpecLocation, TableSpecStore } from './table-spec-store';

/** Who wrote a folder's row last. Stored in `DataFolderTableSpec.source`. */
export type DataFolderTableSpecWriteSource = 'create-folder' | 'refresh-schema' | 'publish-plan-build' | 'pull';
export type DataFolderTableSpecSource = DataFolderTableSpecWriteSource | 'git-import';

/** A location whose folder has a connection: only connector-linked folders have a table spec to store. */
export type ConnectedTableSpecLocation = TableSpecLocation & { connectorAccountId: string };

export type DataFolderTableSpecWriteOutcome =
  /** No row existed; one was inserted. */
  | 'created'
  /** The row's spec changed (ignoring `generatedAt`) and was rewritten. */
  | 'updated'
  /** The row already held this spec (ignoring `generatedAt`); nothing was written. */
  | 'unchanged'
  /** The folder was deleted while we were writing; nothing was stored or mirrored. */
  | 'data-folder-deleted';

export type DataFolderDefaultViewWriteOutcome =
  | 'updated'
  | 'unchanged'
  /** The folder has no row (its spec write failed or the folder is gone); the view was not stored or mirrored. */
  | 'no-table-spec-row';

export type DataFolderTableSpecGitImportOutcome =
  | { kind: 'imported'; importedDefaultView: boolean }
  | { kind: 'would-import'; importedDefaultView: boolean }
  /** The folder already has a row (written by a pull, refresh, or publish build, or an earlier import). */
  | { kind: 'row-already-present' }
  /** Git `main` holds neither `.scratch/{folder}/schema.json` nor the legacy `{folder}/.schema.json`. */
  | { kind: 'no-table-spec-in-git' }
  /** Git holds a file, but not a table spec object; nothing is imported. */
  | { kind: 'invalid-table-spec-in-git'; reason: string }
  /** The connection has no git repo to read (no `repoPath`, or the connection is gone); retrying won't help. */
  | { kind: 'connection-has-no-repo'; error: unknown }
  /** Git couldn't be read (a scratch-git failure, not absence); retried on the next run. */
  | { kind: 'git-read-failed'; error: unknown }
  | { kind: 'data-folder-deleted' };

/**
 * Whether the stored text and the git file differ byte for byte (DEV-13025). Today the CLI cache holds the git bytes,
 * so a byte difference is a folder whose cache the first `scratchmd` refresh from the server rewrites, clearing its
 * `enforce_schema` results (the DEV-10518 hash is over raw bytes). A spec whose only difference is `generatedAt`
 * matches but differs in bytes: `writeSchemaToGit` skips a commit when only `generatedAt` changed.
 */
interface StoredAndGitByteDifferences {
  tableSpecBytesDiffer: boolean;
  defaultViewBytesDiffer: boolean;
}

/** How a folder's stored row compares with its git copy (ignoring `generatedAt`). Read-only. */
export type DataFolderTableSpecGitDivergenceOutcome =
  | ({ kind: 'matches' } & StoredAndGitByteDifferences)
  | ({ kind: 'differs'; tableSpecDiffers: boolean; defaultViewDiffers: boolean } & StoredAndGitByteDifferences)
  /** The folder has no row (the import's job, not the report's). */
  | { kind: 'no-row' }
  | { kind: 'no-table-spec-in-git' }
  | { kind: 'invalid-table-spec-in-git'; reason: string }
  | { kind: 'connection-has-no-repo'; error: unknown }
  | { kind: 'git-read-failed'; error: unknown };

/** A folder's table spec and default view as git `main` holds them, or why they couldn't be read. */
type TableSpecAndDefaultViewReadFromGit =
  | {
      kind: 'found';
      tableSpecFromGit: Record<string, unknown>;
      /** Null when git has no `views/default.json`, or holds one that isn't a JSON object (logged). */
      defaultViewFromGit: Record<string, unknown> | null;
      /** The raw `schema.json` text (or the legacy in-folder `.schema.json` when the new file is absent). */
      tableSpecFileContentFromGit: string;
      /** The raw `views/default.json` text, or null when git has none. */
      defaultViewFileContentFromGit: string | null;
    }
  | { kind: 'no-table-spec-in-git' }
  | { kind: 'invalid-table-spec-in-git'; reason: string }
  | { kind: 'connection-has-no-repo'; error: unknown }
  | { kind: 'git-read-failed'; error: unknown };

/** A connection's stored table specs, keyed the way scratch-git's index build expects them. */
export interface StoredTableSpecsForConnectionRepoIndexBuild {
  /** `repoRelativeFolderKeyForFolderPath(DataFolder.path)` → that folder's stored table spec. */
  tableSpecsByRepoRelativeFolderKey: Record<string, Record<string, unknown>>;
  /** Linked folders with a path but no stored row: scratch-git reads these folders' specs from git. */
  linkedFolderWithoutStoredRowCount: number;
}

/** One linked folder's stored table spec and default view, as `GET /cli/v1/workbooks/:id/table-specs` serves them. */
export interface StoredTableSpecAndDefaultViewForCliCacheRefresh {
  dataFolderId: string;
  folderPath: string;
  /** Null when the folder has no stored row. */
  storedRowUpdatedAt: Date | null;
  tableSpec: CliTableSpecArtifact;
  defaultView: CliTableSpecArtifact;
}

/** One connection's linked folders, sorted by path, for the CLI cache refresh. */
export interface StoredTableSpecsForCliCacheRefreshConnection {
  connectorAccountId: string;
  dataFolders: StoredTableSpecAndDefaultViewForCliCacheRefresh[];
}

/** The default view's file name under `.scratch/{folder}/views/`. Only the default view is ever stored. */
const DEFAULT_VIEW_NAME = 'default';

/**
 * Where a linked DataFolder's table spec and the connector's default view are stored (DEV-12616): the
 * `DataFolderTableSpec` row in Postgres, keyed by the folder's id. This service is the only code that touches
 * that table or the git spec/view primitives on `ScratchGitService`.
 *
 * - **Writes** (create folder, schema refresh, publish build, classic pull) go to Postgres, then are mirrored
 *   one-way to `.scratch/{folder}/schema.json` and `views/default.json` on `main` and `dirty` while
 *   TABLE_SPEC_GIT_MIRROR_ENABLED is on (the default). The mirror is awaited and never throws: the CLI clones
 *   right after a pull, the scratch-git index build reads the git copy at the end of the pull, and a background
 *   commit could race the pull's `git gc` (DEV-11266). The mirror always writes the STORED bytes, re-read just
 *   before writing, so concurrent writers and writes from revisions that predate this table converge on the
 *   database on the next write.
 * - **Reads** come from Postgres while TABLE_SPEC_POSTGRES_READS_ENABLED is on (the default); setting it to false
 *   rolls reads back to the git copy, which the mirror keeps current. A folder with no row falls back to the git
 *   copy, read-only, and counts {@link CustomMetric.DATA_FOLDER_TABLE_SPEC_READ_FELL_BACK_TO_GIT}; a row with no
 *   default view also falls back to git for the view, without counting (connectors that build no view leave it
 *   null). Only the `data-folder-table-spec-git-import` code migration inserts rows from git
 *   ({@link importTableSpecFromGitIfAbsent}).
 * - **The CLI cache refresh** ({@link readTableSpecsAndDefaultViewsForCliCacheRefresh}, DEV-13025) always reads
 *   Postgres, whatever the reads flag says, and serves the stored text verbatim.
 *
 * The Live Export run store has its own store (`RunStoreTableSpecStore`) and never reaches this one.
 */
@Injectable()
export class DataFolderTableSpecStoreService implements TableSpecStore {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
    private readonly scratchConfigService: ScratchConfigService,
    @Inject(CustomMetricsService) private readonly metricsService: CustomMetricsService,
  ) {}

  /**
   * The folder's stored table spec, or null when it has none. Null for a folder with no connection (whether or
   * not a row exists, matching the pre-DEV-12616 behavior for folders whose connection was deleted). Throws when
   * the storage can't be read (the port contract); callers that want null use `readTableSpecOrNullLoggingFailure`.
   */
  async readTableSpec(location: TableSpecLocation): Promise<BaseJsonTableSpec | null> {
    if (!location.connectorAccountId) return null;
    const connectedLocation: ConnectedTableSpecLocation = {
      ...location,
      connectorAccountId: location.connectorAccountId,
    };
    if (!this.scratchConfigService.isTableSpecPostgresReadsEnabled()) {
      return this.readTableSpecFromGit(connectedLocation);
    }

    const storedRow = await this.db.client.dataFolderTableSpec.findUnique({
      where: { dataFolderId: location.dataFolderId },
      select: { tableSpecContent: true },
    });
    if (storedRow) {
      return parseStoredTableSpecContent(storedRow.tableSpecContent, location.dataFolderId);
    }
    this.recordReadFellBackToGit(connectedLocation, 'table-spec');
    return this.readTableSpecFromGit(connectedLocation);
  }

  /**
   * The connector's stored default view for the folder, or null when there is none. With Postgres reads on, a
   * missing row OR a row with no view falls back to the git copy (the view is written after the spec, so a row
   * can briefly exist without one).
   */
  async readDefaultView(location: TableSpecLocation): Promise<TableView | null> {
    if (!location.connectorAccountId) return null;
    const connectedLocation: ConnectedTableSpecLocation = {
      ...location,
      connectorAccountId: location.connectorAccountId,
    };
    if (!this.scratchConfigService.isTableSpecPostgresReadsEnabled()) {
      return this.readDefaultViewFromGit(connectedLocation);
    }

    const storedRow = await this.db.client.dataFolderTableSpec.findUnique({
      where: { dataFolderId: location.dataFolderId },
      select: { defaultViewContent: true },
    });
    if (storedRow?.defaultViewContent) {
      return parseStoredDefaultViewContent(storedRow.defaultViewContent, location.dataFolderId);
    }
    // Only a folder with NO row counts as a fallback: a row without a view is normal for a connector that builds
    // no default view, and counting it would keep the "fallback held at 0" removal signal from ever reaching 0.
    if (!storedRow) this.recordReadFellBackToGit(connectedLocation, 'default-view');
    return this.readDefaultViewFromGit(connectedLocation);
  }

  /**
   * Stores the folder's table spec (with the folder's overrides already applied), then mirrors the stored spec to
   * git. A spec that differs from the stored one only in `generatedAt` is not rewritten, so `updatedAt` means
   * "last real change" — the same rule the git writer has always applied to `schema.json`. Database errors
   * propagate; mirror failures are logged and never thrown.
   */
  async writeTableSpec(
    location: ConnectedTableSpecLocation,
    tableSpec: BaseJsonTableSpec,
    source: DataFolderTableSpecWriteSource,
  ): Promise<DataFolderTableSpecWriteOutcome> {
    const { dataFolderId } = location;
    const tableSpecContent = formatRecordJson(tableSpec as unknown as Record<string, unknown>);

    const existingRow = await this.db.client.dataFolderTableSpec.findUnique({
      where: { dataFolderId },
      select: { tableSpecContent: true },
    });

    let writeOutcome: DataFolderTableSpecWriteOutcome;
    if (
      existingRow &&
      this.storedTableSpecEqualsIgnoringGeneratedAt(existingRow.tableSpecContent, tableSpec, location)
    ) {
      writeOutcome = 'unchanged';
    } else {
      try {
        await this.db.client.dataFolderTableSpec.upsert({
          where: { dataFolderId },
          create: { dataFolderId, tableSpecContent, source },
          update: { tableSpecContent, source },
        });
      } catch (error) {
        if (isForeignKeyViolationOrMissingRecordError(error)) {
          WSLogger.warn({
            source: 'DataFolderTableSpecStoreService.writeTableSpec',
            message: 'The data folder was deleted while its table spec was being stored; nothing was stored',
            dataFolderId,
            folderPath: location.folderPath,
          });
          return 'data-folder-deleted';
        }
        throw error;
      }
      writeOutcome = existingRow ? 'updated' : 'created';
    }

    await this.mirrorStoredTableSpecToGit(location);
    return writeOutcome;
  }

  /**
   * Stores the connector's default view on the folder's row, then mirrors the stored view to git. Writers store the
   * spec first; with no row (the spec write failed or the folder is gone) the view is neither stored nor mirrored.
   */
  async writeDefaultView(
    location: ConnectedTableSpecLocation,
    defaultView: TableView,
    source: DataFolderTableSpecWriteSource,
  ): Promise<DataFolderDefaultViewWriteOutcome> {
    const { dataFolderId } = location;
    const defaultViewContent = formatRecordJson(defaultView as unknown as Record<string, unknown>);

    const existingRow = await this.db.client.dataFolderTableSpec.findUnique({
      where: { dataFolderId },
      select: { defaultViewContent: true },
    });
    if (!existingRow) {
      WSLogger.warn({
        source: 'DataFolderTableSpecStoreService.writeDefaultView',
        message: 'The data folder has no stored table spec, so its default view was not stored',
        dataFolderId,
        folderPath: location.folderPath,
      });
      return 'no-table-spec-row';
    }

    let writeOutcome: DataFolderDefaultViewWriteOutcome = 'unchanged';
    if (existingRow.defaultViewContent !== defaultViewContent) {
      try {
        await this.db.client.dataFolderTableSpec.update({
          where: { dataFolderId },
          data: { defaultViewContent, source },
        });
      } catch (error) {
        if (isForeignKeyViolationOrMissingRecordError(error)) return 'no-table-spec-row';
        throw error;
      }
      writeOutcome = 'updated';
    }

    await this.mirrorStoredDefaultViewToGit(location);
    return writeOutcome;
  }

  /**
   * Copies the folder's table spec and default view from git `main` into a new row, unless the folder already has
   * one (a concurrent real write always wins: the insert is `ON CONFLICT DO NOTHING`). Used only by the
   * `data-folder-table-spec-git-import` code migration; reads never insert. Never writes git. Tells "nothing in
   * git" apart from "git could not be read", and refuses content that isn't a table spec object (git `main` can
   * be pushed to through the CLI's git proxy, so its content isn't trusted blindly).
   */
  async importTableSpecFromGitIfAbsent(
    location: ConnectedTableSpecLocation,
    options: { dryRun: boolean },
  ): Promise<DataFolderTableSpecGitImportOutcome> {
    const { dataFolderId } = location;

    const existingRow = await this.db.client.dataFolderTableSpec.findUnique({
      where: { dataFolderId },
      select: { dataFolderId: true },
    });
    if (existingRow) return { kind: 'row-already-present' };

    const readFromGit = await this.readTableSpecAndDefaultViewFromGit(location);
    if (readFromGit.kind !== 'found') return readFromGit;
    const { tableSpecFromGit, defaultViewFromGit } = readFromGit;
    const defaultViewContent = defaultViewFromGit ? formatRecordJson(defaultViewFromGit) : null;

    const importedDefaultView = defaultViewContent !== null;
    if (options.dryRun) return { kind: 'would-import', importedDefaultView };

    const tableSpecContent = formatRecordJson(tableSpecFromGit);
    const gitImportSource: DataFolderTableSpecSource = 'git-import';
    try {
      const { count: insertedRowCount } = await this.db.client.dataFolderTableSpec.createMany({
        data: [{ dataFolderId, tableSpecContent, defaultViewContent, source: gitImportSource }],
        skipDuplicates: true,
      });
      if (insertedRowCount === 0) return { kind: 'row-already-present' };
    } catch (error) {
      if (isForeignKeyViolationOrMissingRecordError(error)) return { kind: 'data-folder-deleted' };
      throw error;
    }
    return { kind: 'imported', importedDefaultView };
  }

  /**
   * Compares the folder's stored row with its git copy, ignoring `generatedAt` (read-only; for the
   * `data-folder-table-spec-git-divergence-report` code migration). While the git mirror is on the two should
   * match; a difference means a write landed in only one of them — a revision that predates the table wrote git
   * only (a mixed fleet during rollout, or a code rollback), or a mirror write failed. Re-running "Refresh Schema"
   * (or a pull) for the folder rewrites both from the connector.
   */
  async compareStoredRowWithGit(
    location: ConnectedTableSpecLocation,
  ): Promise<DataFolderTableSpecGitDivergenceOutcome> {
    const storedRow = await this.db.client.dataFolderTableSpec.findUnique({
      where: { dataFolderId: location.dataFolderId },
      select: { tableSpecContent: true, defaultViewContent: true },
    });
    if (!storedRow) return { kind: 'no-row' };

    const readFromGit = await this.readTableSpecAndDefaultViewFromGit(location);
    if (readFromGit.kind !== 'found') return readFromGit;

    const tableSpecDiffers = !this.storedTableSpecEqualsIgnoringGeneratedAt(
      storedRow.tableSpecContent,
      readFromGit.tableSpecFromGit as unknown as BaseJsonTableSpec,
      location,
    );
    const storedDefaultView: unknown = storedRow.defaultViewContent ? JSON.parse(storedRow.defaultViewContent) : null;
    const defaultViewDiffers = !isEqual(storedDefaultView, readFromGit.defaultViewFromGit);
    const byteDifferences: StoredAndGitByteDifferences = {
      tableSpecBytesDiffer: storedRow.tableSpecContent !== readFromGit.tableSpecFileContentFromGit,
      defaultViewBytesDiffer: storedRow.defaultViewContent !== readFromGit.defaultViewFileContentFromGit,
    };
    return tableSpecDiffers || defaultViewDiffers
      ? { kind: 'differs', tableSpecDiffers, defaultViewDiffers, ...byteDifferences }
      : { kind: 'matches', ...byteDifferences };
  }

  /**
   * Reads the folder's table spec (with the DEV-10092 legacy-name shim) and default view from git `main`, telling
   * "nothing in git" apart from "git could not be read" and refusing content that isn't a table spec object (git
   * `main` can be pushed to through the CLI's git proxy, so its content isn't trusted blindly).
   */
  private async readTableSpecAndDefaultViewFromGit(
    location: ConnectedTableSpecLocation,
  ): Promise<TableSpecAndDefaultViewReadFromGit> {
    const { dataFolderId, connectorAccountId, folderPath } = location;

    let repoId: string;
    try {
      repoId = await this.scratchGitService.resolveConnectionRepoPath(connectorAccountId);
    } catch (error) {
      return { kind: 'connection-has-no-repo', error };
    }

    let schemaFileContentFromGit: string | null;
    let defaultViewFileContentFromGit: string | null;
    try {
      schemaFileContentFromGit = await this.scratchGitService.readSchemaFileContentFromGitOrThrow(repoId, folderPath);
      if (schemaFileContentFromGit === null) return { kind: 'no-table-spec-in-git' };
      defaultViewFileContentFromGit = await this.scratchGitService.readViewFileContentFromGitOrThrow(
        repoId,
        folderPath,
        DEFAULT_VIEW_NAME,
      );
    } catch (error) {
      return { kind: 'git-read-failed', error };
    }

    let tableSpecFromGit: unknown;
    try {
      tableSpecFromGit = this.scratchGitService.parseSchemaFileContentFromGit(
        repoId,
        folderPath,
        schemaFileContentFromGit,
      );
    } catch {
      return { kind: 'invalid-table-spec-in-git', reason: 'schema.json is not valid JSON' };
    }
    if (!isPlainObject(tableSpecFromGit) || !isPlainObject((tableSpecFromGit as Record<string, unknown>).schema)) {
      return { kind: 'invalid-table-spec-in-git', reason: 'schema.json is not a table spec object with a `schema`' };
    }

    let defaultViewFromGit: Record<string, unknown> | null = null;
    if (defaultViewFileContentFromGit !== null) {
      try {
        const parsedDefaultView: unknown = JSON.parse(defaultViewFileContentFromGit);
        if (isPlainObject(parsedDefaultView)) defaultViewFromGit = parsedDefaultView as Record<string, unknown>;
      } catch {
        // Handled below: an unreadable view is treated as no view.
      }
      if (defaultViewFromGit === null) {
        WSLogger.warn({
          source: 'DataFolderTableSpecStoreService.readTableSpecAndDefaultViewFromGit',
          message: 'views/default.json in git is not a JSON object; treating it as no view',
          dataFolderId,
          folderPath,
        });
      }
    }

    return {
      kind: 'found',
      tableSpecFromGit: tableSpecFromGit as Record<string, unknown>,
      defaultViewFromGit,
      tableSpecFileContentFromGit: schemaFileContentFromGit,
      defaultViewFileContentFromGit,
    };
  }

  /**
   * Every stored table spec for the connection's folders, keyed by repo-relative folder key, for scratch-git's index
   * build (DEV-12616). Null while TABLE_SPEC_POSTGRES_READS_ENABLED is off: git is then the read path, so the index
   * keeps reading specs from git too. A row that isn't a JSON object, or a folder path that can't be a key
   * (scratch-git rejects a key starting or ending with `/`), is left out and logged, so scratch-git reads that folder
   * from git. When two folders share a path, the most recently updated row wins (git, too, holds one spec per path).
   */
  async readStoredTableSpecsForConnectionRepoIndexBuild(
    connectorAccountId: string,
  ): Promise<StoredTableSpecsForConnectionRepoIndexBuild | null> {
    if (!this.scratchConfigService.isTableSpecPostgresReadsEnabled()) return null;

    const linkedFoldersWithStoredRows = await this.db.client.dataFolder.findMany({
      where: { connectorAccountId, path: { not: null } },
      select: {
        id: true,
        path: true,
        storedTableSpecRow: { select: { tableSpecContent: true, updatedAt: true } },
      },
    });

    const tableSpecsByRepoRelativeFolderKey: Record<string, Record<string, unknown>> = {};
    const storedRowUpdatedAtByRepoRelativeFolderKey = new Map<string, { dataFolderId: string; updatedAt: Date }>();
    let linkedFolderWithoutStoredRowCount = 0;

    for (const { id: dataFolderId, path: folderPath, storedTableSpecRow } of linkedFoldersWithStoredRows) {
      if (!folderPath) continue; // excluded by the where clause; narrows the type
      if (!storedTableSpecRow) {
        linkedFolderWithoutStoredRowCount++;
        continue;
      }
      const repoRelativeFolderKey = repoRelativeFolderKeyForFolderPath(folderPath);
      if (repoRelativeFolderKey.startsWith('/') || repoRelativeFolderKey.endsWith('/')) {
        WSLogger.warn({
          source: 'DataFolderTableSpecStoreService.readStoredTableSpecsForConnectionRepoIndexBuild',
          message: 'The folder path cannot be an index-build key; scratch-git reads this folder from git',
          dataFolderId,
          folderPath,
        });
        continue;
      }

      let storedTableSpec: unknown;
      try {
        storedTableSpec = JSON.parse(storedTableSpecRow.tableSpecContent);
      } catch {
        storedTableSpec = undefined;
      }
      if (!isPlainObject(storedTableSpec)) {
        WSLogger.error({
          source: 'DataFolderTableSpecStoreService.readStoredTableSpecsForConnectionRepoIndexBuild',
          message: 'The stored table spec is not a JSON object; scratch-git reads this folder from git',
          dataFolderId,
          folderPath,
        });
        continue;
      }
      // JavaScript keeps a lone UTF-16 surrogate (half an emoji pair cut by an external API) and re-serializes it as a
      // `\ud83d` escape, but scratch-git's JSON parser rejects it, and would fail the whole build with a 400. Leave the
      // folder out instead: scratch-git's git read skips such a spec, so the folder keeps today's behavior.
      if (containsLoneUtf16Surrogate(storedTableSpec)) {
        WSLogger.warn({
          source: 'DataFolderTableSpecStoreService.readStoredTableSpecsForConnectionRepoIndexBuild',
          message:
            'The stored table spec holds a lone UTF-16 surrogate scratch-git cannot parse; it reads this folder from git',
          dataFolderId,
          folderPath,
        });
        continue;
      }

      const rowAlreadyChosenForThisKey = storedRowUpdatedAtByRepoRelativeFolderKey.get(repoRelativeFolderKey);
      if (rowAlreadyChosenForThisKey) {
        WSLogger.warn({
          source: 'DataFolderTableSpecStoreService.readStoredTableSpecsForConnectionRepoIndexBuild',
          message: 'Two folders in the connection share a path; indexing with the most recently updated table spec',
          folderPath,
          dataFolderIds: [rowAlreadyChosenForThisKey.dataFolderId, dataFolderId],
        });
        if (rowAlreadyChosenForThisKey.updatedAt >= storedTableSpecRow.updatedAt) continue;
      }
      tableSpecsByRepoRelativeFolderKey[repoRelativeFolderKey] = storedTableSpec as Record<string, unknown>;
      storedRowUpdatedAtByRepoRelativeFolderKey.set(repoRelativeFolderKey, {
        dataFolderId,
        updatedAt: storedTableSpecRow.updatedAt,
      });
    }

    return { tableSpecsByRepoRelativeFolderKey, linkedFolderWithoutStoredRowCount };
  }

  /**
   * Every linked folder's stored table spec and default view in the workbook (or in one of its connections), for
   * `GET /cli/v1/workbooks/:id/table-specs` (DEV-13025). `scratchmd` writes them into its local cache instead of
   * copying them from the connection repo's git `.scratch/` mirror.
   *
   * - Reads Postgres only. It ignores TABLE_SPEC_POSTGRES_READS_ENABLED and never reads git: Postgres holds every
   *   spec git has, and a client deletes its local copy on `absent`, so `absent` must only ever come from the source
   *   of truth (a missing git copy, or the mirror being off, must never turn into a delete).
   * - Never drops a folder: each one gets a status for both files (`present`, `absent`, or `unreadable`), so the
   *   listing is complete for its scope.
   * - Serves the stored text verbatim, never parsed and re-serialized, so the bytes the CLI writes (and hashes for
   *   DEV-10518) are stable. `sha256` is computed whether or not `content` is included, so the two modes agree.
   * - Connections are the workbook's (the same set as `GET /cli/v1/workbooks/:id`), sorted by id; folders are those
   *   with a path, sorted by path. Both sorts compare UTF-16 code units, so the order doesn't depend on a collation.
   *
   * Throws NotFoundException when `connectorAccountId` isn't a connection in the workbook.
   */
  async readTableSpecsAndDefaultViewsForCliCacheRefresh(
    workbookId: string,
    options: { connectorAccountId?: string; includeContent: boolean },
  ): Promise<StoredTableSpecsForCliCacheRefreshConnection[]> {
    const connectorAccountsWithLinkedFolders = await this.db.client.connectorAccount.findMany({
      where: { workbookId, ...(options.connectorAccountId ? { id: options.connectorAccountId } : {}) },
      select: {
        id: true,
        dataFolders: {
          where: { path: { not: null } },
          select: {
            id: true,
            path: true,
            storedTableSpecRow: { select: { tableSpecContent: true, defaultViewContent: true, updatedAt: true } },
          },
        },
      },
    });
    if (options.connectorAccountId && connectorAccountsWithLinkedFolders.length === 0) {
      throw new NotFoundException(`Connection ${options.connectorAccountId} is not in workbook ${workbookId}`);
    }

    const connectionsForCliCacheRefresh = connectorAccountsWithLinkedFolders.map(
      ({ id: connectorAccountId, dataFolders }): StoredTableSpecsForCliCacheRefreshConnection => {
        const linkedFoldersForCliCacheRefresh: StoredTableSpecAndDefaultViewForCliCacheRefresh[] = [];
        for (const { id: dataFolderId, path: folderPath, storedTableSpecRow } of dataFolders) {
          if (!folderPath) continue; // excluded by the where clause; narrows the type
          linkedFoldersForCliCacheRefresh.push({
            dataFolderId,
            folderPath,
            storedRowUpdatedAt: storedTableSpecRow?.updatedAt ?? null,
            tableSpec: buildCliTableSpecArtifactFromStoredContent(
              storedTableSpecRow?.tableSpecContent ?? null,
              options.includeContent,
            ),
            defaultView: buildCliTableSpecArtifactFromStoredContent(
              storedTableSpecRow?.defaultViewContent ?? null,
              options.includeContent,
            ),
          });
        }
        linkedFoldersForCliCacheRefresh.sort(
          (left, right) =>
            compareByUtf16CodeUnits(left.folderPath, right.folderPath) ||
            compareByUtf16CodeUnits(left.dataFolderId, right.dataFolderId),
        );
        return { connectorAccountId, dataFolders: linkedFoldersForCliCacheRefresh };
      },
    );
    connectionsForCliCacheRefresh.sort((left, right) =>
      compareByUtf16CodeUnits(left.connectorAccountId, right.connectorAccountId),
    );
    return connectionsForCliCacheRefresh;
  }

  /**
   * Rebuilds the connection repo's scratch-git file index with the stored table specs in the request (DEV-12616),
   * so the index's record ids and foreign keys no longer depend on the `.scratch/<folder>/schema.json` git copies.
   * Falls back to a build with no specs, where scratch-git reads every folder from git (correct while the git mirror
   * is on), when the stored specs can't be read or the body is too large; both count
   * {@link CustomMetric.SCRATCH_GIT_INDEX_BUILD_TABLE_SPECS_NOT_SENT}. Other scratch-git errors propagate.
   */
  async rebuildConnectionRepoIndexWithStoredTableSpecs(
    connectorAccountId: string,
    repoId: string,
  ): Promise<{ count: number }> {
    const logContext = {
      source: 'DataFolderTableSpecStoreService.rebuildConnectionRepoIndexWithStoredTableSpecs',
      connectorAccountId,
      repoId,
    };

    let storedTableSpecs: StoredTableSpecsForConnectionRepoIndexBuild | null = null;
    try {
      storedTableSpecs = await this.readStoredTableSpecsForConnectionRepoIndexBuild(connectorAccountId);
    } catch (error) {
      this.recordIndexBuildTableSpecsNotSent(logContext, 'the stored table specs could not be read', error);
    }

    if (storedTableSpecs) {
      const sentTableSpecFolderCount = Object.keys(storedTableSpecs.tableSpecsByRepoRelativeFolderKey).length;
      try {
        const indexBuildResult = await this.scratchGitService.buildIndex(
          repoId,
          storedTableSpecs.tableSpecsByRepoRelativeFolderKey,
        );
        this.checkIndexBuildUsedTheSentTableSpecs(
          indexBuildResult,
          sentTableSpecFolderCount,
          storedTableSpecs,
          logContext,
        );
        return { count: indexBuildResult.count };
      } catch (error) {
        if (
          error instanceof ScratchGitIndexBuildRequestBodyTooLargeError ||
          error instanceof ScratchGitRequestEntityTooLargeError
        ) {
          this.recordIndexBuildTableSpecsNotSent(logContext, 'the request body was too large', error);
        } else if (error instanceof ScratchGitBadRequestError) {
          // scratch-git rejected the body (its build parses the body before touching the repo, so a 400 is about the
          // body). Rebuilding without it keeps the index current; the error log and counter surface the drift.
          this.recordIndexBuildTableSpecsNotSent(logContext, 'scratch-git rejected the request body', error, 'error');
        } else {
          throw error;
        }
      }
    }

    const indexBuildResult = await this.scratchGitService.buildIndex(repoId);
    return { count: indexBuildResult.count };
  }

  private checkIndexBuildUsedTheSentTableSpecs(
    indexBuildResult: BuildRepoIndexResult,
    sentTableSpecFolderCount: number,
    storedTableSpecs: StoredTableSpecsForConnectionRepoIndexBuild,
    logContext: { source: string; connectorAccountId: string; repoId: string },
  ): void {
    const { tableSpecFolderCountFromRequestBody, tableSpecFolderCountReadFromGit } = indexBuildResult;
    if (tableSpecFolderCountFromRequestBody === undefined) {
      // A scratch-git that predates the request body ignored it and read every folder from git (correct while the
      // git mirror is on). Only happens while the two deploys overlap.
      WSLogger.debug({ ...logContext, message: 'scratch-git ignored the index-build table specs (older service)' });
      return;
    }
    if (tableSpecFolderCountFromRequestBody !== sentTableSpecFolderCount) {
      WSLogger.error({
        ...logContext,
        message: 'scratch-git used a different number of table specs than were sent; the index-build contract drifted',
        sentTableSpecFolderCount,
        tableSpecFolderCountFromRequestBody,
      });
    }
    if (tableSpecFolderCountReadFromGit !== undefined && tableSpecFolderCountReadFromGit > 0) {
      WSLogger.info({
        ...logContext,
        message: "scratch-git read some folders' table specs from git because the request had none for them",
        tableSpecFolderCountReadFromGit,
        linkedFolderWithoutStoredRowCount: storedTableSpecs.linkedFolderWithoutStoredRowCount,
      });
      this.metricsService.logValue(
        CustomMetric.SCRATCH_GIT_INDEX_BUILD_READ_TABLE_SPEC_FROM_GIT,
        tableSpecFolderCountReadFromGit,
      );
    }
  }

  private recordIndexBuildTableSpecsNotSent(
    logContext: { source: string; connectorAccountId: string; repoId: string },
    reason: string,
    error: unknown,
    logLevel: 'warn' | 'error' = 'warn',
  ): void {
    const logEntry = {
      ...logContext,
      message: `Building the index without stored table specs because ${reason}; scratch-git reads them from git`,
      error,
    };
    if (logLevel === 'error') WSLogger.error(logEntry);
    else WSLogger.warn(logEntry);
    this.metricsService.logValue(CustomMetric.SCRATCH_GIT_INDEX_BUILD_TABLE_SPECS_NOT_SENT, 1);
  }

  private async readTableSpecFromGit(location: ConnectedTableSpecLocation): Promise<BaseJsonTableSpec | null> {
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(location.connectorAccountId);
    return this.scratchGitService.readSchemaFromGit(repoId, location.folderPath);
  }

  private async readDefaultViewFromGit(location: ConnectedTableSpecLocation): Promise<TableView | null> {
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(location.connectorAccountId);
    return this.scratchGitService.readViewFromGit(repoId, location.folderPath, DEFAULT_VIEW_NAME);
  }

  private recordReadFellBackToGit(location: ConnectedTableSpecLocation, artifact: 'table-spec' | 'default-view'): void {
    WSLogger.info({
      source: 'DataFolderTableSpecStoreService.recordReadFellBackToGit',
      message: 'No table spec stored in Postgres for this folder; reading the git copy',
      artifact,
      dataFolderId: location.dataFolderId,
      connectorAccountId: location.connectorAccountId,
      folderPath: location.folderPath,
    });
    this.metricsService.logValue(CustomMetric.DATA_FOLDER_TABLE_SPEC_READ_FELL_BACK_TO_GIT, 1);
  }

  /**
   * True when the stored row holds the same spec as `tableSpec`, ignoring `generatedAt`. A stored row that isn't
   * a JSON object counts as changed, so the write overwrites it (the git writer self-heals the same way).
   */
  private storedTableSpecEqualsIgnoringGeneratedAt(
    storedTableSpecContent: string,
    tableSpec: BaseJsonTableSpec,
    location: ConnectedTableSpecLocation,
  ): boolean {
    let storedTableSpec: unknown;
    try {
      storedTableSpec = JSON.parse(storedTableSpecContent);
    } catch {
      storedTableSpec = undefined;
    }
    if (!isPlainObject(storedTableSpec)) {
      WSLogger.warn({
        source: 'DataFolderTableSpecStoreService.writeTableSpec',
        message: 'The stored table spec is not a JSON object; overwriting it',
        dataFolderId: location.dataFolderId,
        folderPath: location.folderPath,
      });
      return false;
    }
    return isEqual(
      stripGeneratedAt(storedTableSpec as Record<string, unknown>),
      stripGeneratedAt(tableSpec as unknown as Record<string, unknown>),
    );
  }

  /** Writes the STORED spec to git (re-read now, so the last database write wins). Awaited; never throws. */
  private async mirrorStoredTableSpecToGit(location: ConnectedTableSpecLocation): Promise<void> {
    if (!this.scratchConfigService.isTableSpecGitMirrorEnabled()) return;
    try {
      const storedRow = await this.db.client.dataFolderTableSpec.findUnique({
        where: { dataFolderId: location.dataFolderId },
        select: { tableSpecContent: true },
      });
      if (!storedRow) return;
      const storedTableSpec = parseStoredTableSpecContent(storedRow.tableSpecContent, location.dataFolderId);
      const repoId = await this.scratchGitService.resolveConnectionRepoPath(location.connectorAccountId);
      await this.scratchGitService.writeSchemaToGit(repoId, location.folderPath, storedTableSpec);
    } catch (error) {
      WSLogger.warn({
        source: 'DataFolderTableSpecStoreService.mirrorStoredTableSpecToGit',
        message: 'Failed to mirror the stored table spec to git; the next write retries',
        dataFolderId: location.dataFolderId,
        connectorAccountId: location.connectorAccountId,
        folderPath: location.folderPath,
        error,
      });
    }
  }

  /** Writes the STORED default view to git (re-read now). Awaited; never throws. */
  private async mirrorStoredDefaultViewToGit(location: ConnectedTableSpecLocation): Promise<void> {
    if (!this.scratchConfigService.isTableSpecGitMirrorEnabled()) return;
    try {
      const storedRow = await this.db.client.dataFolderTableSpec.findUnique({
        where: { dataFolderId: location.dataFolderId },
        select: { defaultViewContent: true },
      });
      if (!storedRow?.defaultViewContent) return;
      const storedDefaultView = parseStoredDefaultViewContent(storedRow.defaultViewContent, location.dataFolderId);
      const repoId = await this.scratchGitService.resolveConnectionRepoPath(location.connectorAccountId);
      await this.scratchGitService.writeViewToGit(repoId, location.folderPath, DEFAULT_VIEW_NAME, storedDefaultView);
    } catch (error) {
      WSLogger.warn({
        source: 'DataFolderTableSpecStoreService.mirrorStoredDefaultViewToGit',
        message: 'Failed to mirror the stored default view to git; the next write retries',
        dataFolderId: location.dataFolderId,
        connectorAccountId: location.connectorAccountId,
        folderPath: location.folderPath,
        error,
      });
    }
  }
}

function parseStoredTableSpecContent(tableSpecContent: string, dataFolderId: string): BaseJsonTableSpec {
  const parsed: unknown = JSON.parse(tableSpecContent);
  if (!isPlainObject(parsed)) {
    throw new Error(`The stored table spec for data folder ${dataFolderId} is not a JSON object`);
  }
  return parsed as BaseJsonTableSpec;
}

function parseStoredDefaultViewContent(defaultViewContent: string, dataFolderId: string): TableView {
  const parsed: unknown = JSON.parse(defaultViewContent);
  if (!isPlainObject(parsed)) {
    throw new Error(`The stored default view for data folder ${dataFolderId} is not a JSON object`);
  }
  return parsed as TableView;
}

/**
 * How the CLI should treat its local copy of one stored file (DEV-13025): `absent` when nothing is stored,
 * `unreadable` when the stored text isn't a JSON object (the CLI keeps its copy and warns), and otherwise `present`
 * with the SHA-256 of the stored text's UTF-8 bytes and, when asked for, the text itself, verbatim.
 */
function buildCliTableSpecArtifactFromStoredContent(
  storedContent: string | null,
  includeContent: boolean,
): CliTableSpecArtifact {
  if (storedContent === null) return { status: 'absent' };
  let parsedStoredContent: unknown;
  try {
    parsedStoredContent = JSON.parse(storedContent);
  } catch {
    parsedStoredContent = undefined;
  }
  if (!isPlainObject(parsedStoredContent)) {
    return { status: 'unreadable', reason: 'stored-content-not-a-json-object' };
  }
  const sha256 = createHash('sha256').update(storedContent, 'utf8').digest('hex');
  return includeContent ? { status: 'present', sha256, content: storedContent } : { status: 'present', sha256 };
}

/** A locale-independent string order (UTF-16 code units), so a listing's order never depends on a collation. */
function compareByUtf16CodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** A UTF-16 surrogate half with no partner: legal in a JavaScript string, rejected by scratch-git's JSON parser. */
const LONE_UTF16_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** True when any string in the parsed JSON value (object keys included) holds a lone UTF-16 surrogate. */
function containsLoneUtf16Surrogate(jsonValue: unknown): boolean {
  if (typeof jsonValue === 'string') return LONE_UTF16_SURROGATE_PATTERN.test(jsonValue);
  if (Array.isArray(jsonValue)) return jsonValue.some(containsLoneUtf16Surrogate);
  if (jsonValue !== null && typeof jsonValue === 'object') {
    return Object.entries(jsonValue).some(
      ([propertyName, propertyValue]) =>
        LONE_UTF16_SURROGATE_PATTERN.test(propertyName) || containsLoneUtf16Surrogate(propertyValue),
    );
  }
  return false;
}

/**
 * P2003: the insert's foreign key to DataFolder failed (the folder was deleted). P2025: the row to update is gone
 * (the folder, and with it the row, was deleted). Both mean "nothing to store for this folder".
 */
function isForeignKeyViolationOrMissingRecordError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2003' || error.code === 'P2025');
}
