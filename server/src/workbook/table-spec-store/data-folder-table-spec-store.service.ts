import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { formatRecordJson, type TableView } from '@spinner/shared-types';
import { isEqual, isPlainObject } from 'lodash';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { CustomMetric } from 'src/metrics/custom-metrics';
import { CustomMetricsService } from 'src/metrics/custom-metrics-service';
import type { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { ScratchGitService, stripGeneratedAt } from 'src/scratch-git/scratch-git.service';
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

/** How a folder's stored row compares with its git copy (ignoring `generatedAt`). Read-only. */
export type DataFolderTableSpecGitDivergenceOutcome =
  | { kind: 'matches' }
  | { kind: 'differs'; tableSpecDiffers: boolean; defaultViewDiffers: boolean }
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
    }
  | { kind: 'no-table-spec-in-git' }
  | { kind: 'invalid-table-spec-in-git'; reason: string }
  | { kind: 'connection-has-no-repo'; error: unknown }
  | { kind: 'git-read-failed'; error: unknown };

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
 * - **Reads** come from Postgres only when TABLE_SPEC_POSTGRES_READS_ENABLED is on; until then they read the git
 *   copy exactly as before, so a rollout with a mixed fleet (an old worker writing git only) can't serve a stale
 *   row. With Postgres reads on, a folder with no row (or a row with no view) falls back to the git copy,
 *   read-only, and counts {@link CustomMetric.DATA_FOLDER_TABLE_SPEC_READ_FELL_BACK_TO_GIT}. Only the
 *   `data-folder-table-spec-git-import` code migration inserts rows from git
 *   ({@link importTableSpecFromGitIfAbsent}).
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
    return tableSpecDiffers || defaultViewDiffers
      ? { kind: 'differs', tableSpecDiffers, defaultViewDiffers }
      : { kind: 'matches' };
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

    return { kind: 'found', tableSpecFromGit: tableSpecFromGit as Record<string, unknown>, defaultViewFromGit };
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
 * P2003: the insert's foreign key to DataFolder failed (the folder was deleted). P2025: the row to update is gone
 * (the folder, and with it the row, was deleted). Both mean "nothing to store for this folder".
 */
function isForeignKeyViolationOrMissingRecordError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && (error.code === 'P2003' || error.code === 'P2025');
}
