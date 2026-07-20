import { ConflictException, Injectable } from '@nestjs/common';
import { ConnectionMigratingBlockedResponseDto, JobType } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import type { JobData } from 'src/worker/jobs/union-types';

/**
 * DEV-9698 (T4) — the per-connection migration lock.
 *
 * A connection (`ConnectorAccount`) is "locked" while a code-migration is
 * quiescing it: `ConnectorAccount.migrationLockedAt` is set on the way in and
 * cleared on the way out (see `ConnectionQuiesceService`). While locked, two
 * classes of work are rejected so they can't race the migration's folder move:
 *
 *   - **live edits** — web record create/update/delete and the CLI
 *     `/upload-patch/commit` write to the dirty branch; a write racing the move
 *     orphans a record at the old path. Gated via {@link assertConnectionNotMigrating}.
 *   - **new job enqueues** — pull / publish / sync / apply-patches jobs touch the
 *     connection's folders. Gated centrally in `BullEnqueuerService.createAndEnqueue`
 *     via {@link assertEnqueueAllowedForJob}, which closes the
 *     drain-then-immediately-re-enqueue race the drain step alone can't.
 *
 * This service is intentionally lightweight — it depends only on Prisma — so it
 * can be injected into low-level write/enqueue paths without dragging in the
 * heavier quiesce orchestration (schedules / publish plans / job draining) and
 * without risking a NestJS provider cycle. The `JobData` import is type-only
 * (erased at runtime), so it adds no runtime dependency on the worker module.
 */
@Injectable()
export class MigrationLockService {
  constructor(private readonly db: DbService) {}

  /** Take the lock for a connection (idempotent — overwrites the timestamp). */
  async lockConnection(connectorAccountId: string): Promise<void> {
    await this.db.client.connectorAccount.update({
      where: { id: connectorAccountId },
      data: { migrationLockedAt: new Date() },
    });
  }

  /** Release the lock for a connection (idempotent — clearing an unset lock is a no-op). */
  async unlockConnection(connectorAccountId: string): Promise<void> {
    await this.db.client.connectorAccount.update({
      where: { id: connectorAccountId },
      data: { migrationLockedAt: null },
    });
  }

  /** True when the connection is currently locked for migration. */
  async isConnectionMigrating(connectorAccountId: string): Promise<boolean> {
    const account = await this.db.client.connectorAccount.findUnique({
      where: { id: connectorAccountId },
      select: { migrationLockedAt: true },
    });
    return account?.migrationLockedAt != null;
  }

  /**
   * Throw a 409 if the connection is being migrated. The gate for live edits.
   * Accepts a nullable id (callers resolve the connector account from a path and
   * may have none — a record with no connection can't be locked) and is a no-op
   * in that case.
   */
  async assertConnectionNotMigrating(connectorAccountId: string | null | undefined): Promise<void> {
    if (!connectorAccountId) return;
    if (await this.isConnectionMigrating(connectorAccountId)) {
      throw this.blockedException(connectorAccountId);
    }
  }

  /**
   * Throw a 409 if enqueuing `data` would start work on a connection that is
   * being migrated. The gate for new job enqueues, called from the single
   * `createAndEnqueue` chokepoint.
   *
   * Fast path: if no connection anywhere is locked (the overwhelmingly common
   * case — one cheap indexed lookup against `ConnectorAccount_migrationLockedAt_idx`),
   * it returns immediately without resolving the job's connection. Only when some
   * connection IS locked does it resolve the job's connector account(s) and check
   * them.
   */
  async assertEnqueueAllowedForJob(data: JobData): Promise<void> {
    const anyLocked = await this.db.client.connectorAccount.findFirst({
      where: { migrationLockedAt: { not: null } },
      select: { id: true },
    });
    if (!anyLocked) return;

    const connectorAccountIds = await this.resolveConnectorAccountIdsForJob(data);
    if (connectorAccountIds.length === 0) return;

    const lockedAccount = await this.db.client.connectorAccount.findFirst({
      where: { id: { in: connectorAccountIds }, migrationLockedAt: { not: null } },
      select: { id: true },
    });
    if (lockedAccount) {
      throw this.blockedException(lockedAccount.id);
    }
  }

  /**
   * Map a job to the connector account(s) it touches. Publish / ApplyPatches
   * carry `connectorAccountId` directly; pull / rehost carry a `dataFolderId(s)`
   * we resolve to their account; sync carries a `syncId` we resolve via its table
   * pairs' source + destination folders. DeleteWorkbook is workbook-scoped and
   * touches no single connection.
   *
   * Public because the quiesce job-drain reuses it to scope a workbook's in-flight
   * jobs down to the connection being migrated (the same job→account mapping the
   * enqueue gate uses, kept in one place).
   */
  async resolveConnectorAccountIdsForJob(data: JobData): Promise<string[]> {
    switch (data.type) {
      case JobType.Publish:
        return data.connectorAccountId ? [data.connectorAccountId] : [];
      case JobType.ApplyPatches:
        return [data.connectorAccountId];
      case JobType.RefreshRecords:
      case JobType.RehostAssets:
        return this.connectorAccountIdsForFolders([data.dataFolderId]);
      case JobType.PullLinkedFolderFiles:
        return this.connectorAccountIdsForFolders(data.dataFolderIds);
      // THROWAWAY: the temporary pull-then-sync job touches the same connections
      // as the sync it wraps.
      case JobType.SyncDataFolders:
      case JobType.TemporarySyncWithPull:
        return this.connectorAccountIdsForSync(data.syncId);
      // Post-delete orphan cleanup touches exactly the one connection whose FileIndex/
      // FileReference rows it removes. The ConnectorAccount is already deleted by the
      // time this is enqueued, so it can't collide with a live migration lock.
      case JobType.CleanupConnectionIndexRows:
        return [data.connectorAccountId];
      // Workbook-scoped jobs that touch no single connection: the hard delete drains the whole
      // workbook, and the pre-flight discard clears every connection's working set at once.
      case JobType.DeleteWorkbook:
      case JobType.DiscardPendingChanges:
        return [];
    }
  }

  private async connectorAccountIdsForFolders(dataFolderIds: readonly string[]): Promise<string[]> {
    if (dataFolderIds.length === 0) return [];
    const folders = await this.db.client.dataFolder.findMany({
      where: { id: { in: [...dataFolderIds] } },
      select: { connectorAccountId: true },
    });
    return this.dedupeNonNull(folders.map((folder) => folder.connectorAccountId));
  }

  private async connectorAccountIdsForSync(syncId: string): Promise<string[]> {
    const pairs = await this.db.client.syncTablePair.findMany({
      where: { syncId },
      select: {
        sourceDataFolder: { select: { connectorAccountId: true } },
        destinationDataFolder: { select: { connectorAccountId: true } },
      },
    });
    return this.dedupeNonNull(
      pairs.flatMap((pair) => [
        pair.sourceDataFolder?.connectorAccountId,
        pair.destinationDataFolder?.connectorAccountId,
      ]),
    );
  }

  private dedupeNonNull(ids: readonly (string | null | undefined)[]): string[] {
    return [...new Set(ids.filter((id): id is string => id != null))];
  }

  private blockedException(connectorAccountId: string): ConflictException {
    const body: ConnectionMigratingBlockedResponseDto = {
      status: 'blocked_migrating',
      connectorAccountId,
      message: 'This connection is being migrated to the new folder layout. Please retry in a moment.',
    };
    return new ConflictException(body);
  }
}
