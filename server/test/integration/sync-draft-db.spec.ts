/**
 * Real-Postgres integration tests for SyncDraftService — the things mocks can't
 * prove: that the optimistic-concurrency conditional update actually rejects a
 * stale write, that the Workbook→SyncDraft `onDelete: Cascade` actually removes
 * drafts, and that `fromSyncId` conversion + archive gating persist correctly.
 *
 * Mirrors `sync-service.spec.ts` / `sync-archive-e2e.spec.ts`: real Prisma,
 * services that aren't under test are mocked. Materialize/apply (which hit real
 * connectors) are out of scope here — they're covered by the service unit spec.
 */

import { ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createSyncId, createWorkbookId, type SyncId, type WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { RoutineService } from 'src/routine/routine.service';
import { SchemaBuilderService } from 'src/schema-builder/schema-builder.service';
import { SyncDraftService } from 'src/sync-draft/sync-draft.service';
import { SyncService } from 'src/sync/sync.service';
import { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { WorkbookService } from 'src/workbook/workbook.service';

describe('SyncDraftService (real DB)', () => {
  let prisma: PrismaClient;
  let service: SyncDraftService;
  let syncService: { getSync: jest.Mock };

  let orgId: string;
  let userId: string;
  let workbookId: WorkbookId;
  const actor: Actor = { userId: 'test-user', organizationId: 'test-org' };

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  beforeEach(async () => {
    const dbService = { client: prisma } as unknown as DbService;
    const workbookService = {
      assertWritableWorkbook: jest.fn().mockResolvedValue({ id: workbookId }),
      assertReadableWorkbook: jest.fn().mockResolvedValue({ id: workbookId }),
    } as unknown as WorkbookService;
    syncService = { getSync: jest.fn() };
    service = new SyncDraftService(
      dbService,
      workbookService,
      syncService as unknown as SyncService,
      {} as unknown as SchemaBuilderService,
      {} as unknown as DataFolderService,
      {} as unknown as RoutineService,
    );

    const org = await prisma.organization.create({
      data: { id: 'org_syncdraft_' + Date.now(), name: 'Test Org', clerkId: 'clerk_syncdraft_' + Date.now() },
    });
    orgId = org.id;
    const user = await prisma.user.create({
      data: {
        id: 'user_syncdraft_' + Date.now(),
        email: `syncdraft-${Date.now()}@example.com`,
        organizationId: org.id,
      },
    });
    userId = user.id;
    const wbId = createWorkbookId();
    await prisma.workbook.create({
      data: { id: wbId, name: 'Test Workbook', userId: user.id, organizationId: org.id },
    });
    workbookId = wbId;
  });

  afterEach(async () => {
    await prisma.syncDraft.deleteMany({ where: { workbookId } });
    await prisma.sync.deleteMany({ where: { workbookId } });
    await prisma.workbook.deleteMany({ where: { id: workbookId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('round-trips create → get → patch → delete against the DB', async () => {
    const created = await service.getOrCreate(workbookId, {} as never, actor);
    expect(created.version).toBe(1);
    expect(await prisma.syncDraft.findUnique({ where: { id: created.id } })).not.toBeNull();

    const fetched = await service.get(created.id, actor);
    expect(fetched.id).toBe(created.id);

    const patched = await service.patch(created.id, { version: 1, displayName: 'Renamed' } as never, actor);
    expect(patched.version).toBe(2);
    expect(patched.displayName).toBe('Renamed');
    const stored = await prisma.syncDraft.findUnique({ where: { id: created.id } });
    expect(stored?.displayName).toBe('Renamed');

    await service.delete(created.id, actor);
    expect(await prisma.syncDraft.findUnique({ where: { id: created.id } })).toBeNull();
    await expect(service.get(created.id, actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects a stale-version patch with a 409 (conditional update, not a read-then-write race)', async () => {
    const created = await service.getOrCreate(workbookId, {} as never, actor);

    const first = await service.patch(created.id, { version: 1, displayName: 'First' } as never, actor);
    expect(first.version).toBe(2);

    // Re-using the now-stale version 1 must fail.
    await expect(
      service.patch(created.id, { version: 1, displayName: 'Second' } as never, actor),
    ).rejects.toBeInstanceOf(ConflictException);
    const stored = await prisma.syncDraft.findUnique({ where: { id: created.id } });
    expect(stored?.displayName).toBe('First'); // the losing write did not land
  });

  it('cascade-deletes drafts when their workbook is deleted', async () => {
    const created = await service.getOrCreate(workbookId, {} as never, actor);
    expect(await prisma.syncDraft.findUnique({ where: { id: created.id } })).not.toBeNull();

    await prisma.workbook.delete({ where: { id: workbookId } });

    expect(await prisma.syncDraft.findUnique({ where: { id: created.id } })).toBeNull();
  });

  it('refuses to patch an archived draft with a 409', async () => {
    const created = await service.getOrCreate(workbookId, {} as never, actor);
    await prisma.syncDraft.update({
      where: { id: created.id },
      data: { archivedAt: new Date(), appliedSyncId: createSyncId() },
    });

    await expect(service.patch(created.id, { version: 1, displayName: 'x' } as never, actor)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('initializes a draft from an existing sync (fromSyncId)', async () => {
    const sourceSyncId = createSyncId();
    syncService.getSync.mockResolvedValue({
      id: sourceSyncId,
      workbookId,
      displayName: 'Contacts → Airtable',
      mappings: {
        version: 2,
        tableMappings: [
          {
            sourceDataFolderId: 'dfd_src1',
            destinationDataFolderId: 'dfd_dst1',
            columnMappings: [{ destinationColumnId: 'name', source: { kind: 'column', columnId: 'title' } }],
          },
        ],
      },
    });

    const created = await service.getOrCreate(workbookId, { fromSyncId: sourceSyncId } as never, actor);

    expect(created.sourceSyncId).toBe(sourceSyncId);
    expect(created.displayName).toBe('Contacts → Airtable');
    expect(created.tableMappings).toHaveLength(1);
    expect(created.tableMappings[0].destination).toEqual({ kind: 'existing', dataFolderId: 'dfd_dst1' });

    const stored = await prisma.syncDraft.findUnique({ where: { id: created.id } });
    expect(stored?.sourceSyncId).toBe(sourceSyncId);
  });

  it('get-or-create is idempotent for the same target — concurrent opens converge on one draft', async () => {
    // Two simultaneous "cold load" opens (e.g. two browser tabs) must resolve to
    // the same draft, not race into duplicates. The advisory lock serializes them.
    const [a, b] = await Promise.all([
      service.getOrCreate(workbookId, {} as never, actor),
      service.getOrCreate(workbookId, {} as never, actor),
    ]);

    expect(a.id).toBe(b.id);
    const rows = await prisma.syncDraft.findMany({ where: { workbookId, archivedAt: null } });
    expect(rows).toHaveLength(1);
  });

  it('opens a fresh draft once the previous one for a target is archived', async () => {
    const first = await service.getOrCreate(workbookId, {} as never, actor);
    await prisma.syncDraft.update({
      where: { id: first.id },
      data: { archivedAt: new Date(), appliedSyncId: createSyncId() },
    });

    const second = await service.getOrCreate(workbookId, {} as never, actor);

    expect(second.id).not.toBe(first.id);
    expect(second.archivedAt).toBeNull();
    const active = await prisma.syncDraft.findMany({ where: { workbookId, archivedAt: null } });
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(second.id);
  });

  it('exposes the applied sync id and archived flag after a manual archive', async () => {
    const created = await service.getOrCreate(workbookId, {} as never, actor);
    const appliedSyncId: SyncId = createSyncId();
    await prisma.syncDraft.update({ where: { id: created.id }, data: { archivedAt: new Date(), appliedSyncId } });

    const fetched = await service.get(created.id, actor);
    expect(fetched.archivedAt).not.toBeNull();
    expect(fetched.appliedSyncId).toBe(appliedSyncId);
  });
});
