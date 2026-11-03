import { Injectable } from '@nestjs/common';
import { RoutineDefinition as PrismaRoutineDefinition } from '@prisma/client';
import { createRoutineDefinitionId, WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { assertValidRoutineFilePath } from './routine-file-path';

/**
 * Where a routine definition's current content came from (`RoutineDefinition.source`). Nothing
 * writes `'cli'` since the CLI push was removed (DEV-12661) or `'git-import'` since the one-time
 * git import was removed (DEV-12620), but existing rows may still carry either.
 */
export type RoutineDefinitionSource = 'web' | 'cli' | 'generated' | 'git-import';

/** What {@link RoutineDefinitionStoreService.upsertDefinition} did with the row. */
export type RoutineDefinitionWriteOutcome = 'created' | 'updated' | 'unchanged';

/**
 * The single owner of routine *definitions*: the `RoutineDefinition` table (DEV-11399). Every
 * reader of a routine's YAML — the REST list/get/edit endpoints, the executor's `triggerRun`, the
 * scheduler — goes through here. Postgres is the only store; the workbook config git repo is no
 * longer read or written for routines (DEV-12620).
 */
@Injectable()
export class RoutineDefinitionStoreService {
  constructor(private readonly db: DbService) {}

  /** Every routine definition of the workbook, ordered by file path. */
  async listDefinitions(workbookId: WorkbookId): Promise<PrismaRoutineDefinition[]> {
    return this.db.client.routineDefinition.findMany({ where: { workbookId }, orderBy: { filePath: 'asc' } });
  }

  /** One routine definition by file path, or `null` when it does not exist. */
  async getDefinition(workbookId: WorkbookId, filePath: string): Promise<PrismaRoutineDefinition | null> {
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
    const deleted = await this.db.client.routineDefinition.deleteMany({ where: { workbookId, filePath } });
    return deleted.count === 1;
  }
}
