/**
 * DB-backed integration test for DEV-12324 (cleanup of rehosted asset files), run against real Postgres.
 *
 * The unit specs mock Prisma. This spec validates what those mocks can't:
 *   - the `Asset.dataFolder` FK cascades (migration `20261014120000_asset_data_folder_on_delete_cascade`):
 *     deleting a data folder deletes its Asset rows, and sync-derived rows in other folders keep their own
 *     `rehostedUrl` copy with `sourceAssetId` nulled;
 *   - the rehosted-asset reaper's raw tripwire SQL and its `startsWith` reference queries behave as intended.
 * Every URL uses a bucket name unique to this run, so the assertions hold on a database that has other data.
 */

import { PrismaClient } from '@prisma/client';
import { createAssetId, createDataFolderId, createOrganizationId, createWorkbookId } from '@spinner/shared-types';
import {
  countRehostedUrlsOutsideTheirOwnWorkbookKeyPrefix,
  loadAssetUrlsReferencingPublicUrlPrefix,
} from 'src/cron/rehosted-asset-reaper.service';
import { DbService } from 'src/db/db.service';
import { createIntegrationTestDbService } from './integration-db-service';

describe('rehosted asset cleanup (DB-backed)', () => {
  let prisma: PrismaClient;
  let db: DbService;

  const organizationId = createOrganizationId();
  const workbookId = createWorkbookId();
  const otherWorkbookId = createWorkbookId();
  // Bucket names are lowercase; the workbook id makes this one unique to the run.
  const publicUrlPrefix = `https://storage.googleapis.com/it-assets-${workbookId.toLowerCase().replace('_', '-')}/`;
  const workbookPublicUrlPrefix = `${publicUrlPrefix}v1/${workbookId}/`;
  const otherWorkbookPublicUrlPrefix = `${publicUrlPrefix}v1/${otherWorkbookId}/`;

  async function createDataFolder(folderWorkbookId: string, name: string): Promise<string> {
    const dataFolderId = createDataFolderId();
    await prisma.dataFolder.create({ data: { id: dataFolderId, name, workbookId: folderWorkbookId } });
    return dataFolderId;
  }

  async function createAsset(data: {
    workbookId: string;
    dataFolderId: string;
    rehostedUrl?: string;
    url?: string;
    sourceAssetId?: string;
  }): Promise<string> {
    const assetId = createAssetId();
    await prisma.asset.create({
      data: { id: assetId, service: 'AIRTABLE', remoteAssetId: `remote_${assetId}`, ...data },
    });
    return assetId;
  }

  beforeAll(async () => {
    prisma = new PrismaClient();
    db = createIntegrationTestDbService(prisma);

    await prisma.organization.create({
      data: { id: organizationId, name: 'Asset Cleanup Org', clerkId: `clerk_ac_${organizationId}` },
    });
    await prisma.workbook.create({ data: { id: workbookId, name: 'Asset Cleanup WB', organizationId } });
    await prisma.workbook.create({ data: { id: otherWorkbookId, name: 'Asset Cleanup Other WB', organizationId } });
  });

  afterEach(async () => {
    // Clear every test row explicitly, so no test depends on another's cleanup (or on the FK behavior under test).
    const testWorkbookIds = [workbookId, otherWorkbookId];
    await prisma.asset.deleteMany({ where: { workbookId: { in: testWorkbookIds } } });
    await prisma.dataFolder.deleteMany({ where: { workbookId: { in: testWorkbookIds } } });
  });

  afterAll(async () => {
    // Deleting the workbooks cascades their data folders and assets.
    await prisma.workbook.deleteMany({ where: { id: { in: [workbookId, otherWorkbookId] } } });
    await prisma.organization.deleteMany({ where: { id: organizationId } });
    await prisma.$disconnect();
  });

  describe('Asset rows follow their data folder', () => {
    it('deleting a source folder deletes its assets; a derived row elsewhere keeps its rehostedUrl copy', async () => {
      const sourceDataFolderId = await createDataFolder(workbookId, 'Cascade source');
      const destinationDataFolderId = await createDataFolder(workbookId, 'Cascade destination');
      const rehostedUrl = `${workbookPublicUrlPrefix}AIRTABLE/0123abcd/photo.jpg`;
      const sourceAssetId = await createAsset({ workbookId, dataFolderId: sourceDataFolderId, rehostedUrl });
      const derivedAssetId = await createAsset({
        workbookId,
        dataFolderId: destinationDataFolderId,
        rehostedUrl,
        sourceAssetId,
      });

      await prisma.dataFolder.delete({ where: { id: sourceDataFolderId } });

      expect(await prisma.asset.findUnique({ where: { id: sourceAssetId } })).toBeNull();
      const derivedAsset = await prisma.asset.findUniqueOrThrow({ where: { id: derivedAssetId } });
      expect(derivedAsset.sourceAssetId).toBeNull();
      expect(derivedAsset.rehostedUrl).toBe(rehostedUrl);

      await prisma.dataFolder.delete({ where: { id: destinationDataFolderId } });

      expect(await prisma.asset.findUnique({ where: { id: derivedAssetId } })).toBeNull();
    });
  });

  describe('reaper queries', () => {
    it('the tripwire counts a rehostedUrl outside its own workbook prefix, matching workbook ids literally', async () => {
      const dataFolderId = await createDataFolder(workbookId, 'Tripwire');
      // Every rehosted row in the database that isn't under this run's bucket already counts, so assert deltas.
      const countBefore = await countRehostedUrlsOutsideTheirOwnWorkbookKeyPrefix(db, publicUrlPrefix);

      await createAsset({ workbookId, dataFolderId, rehostedUrl: `${workbookPublicUrlPrefix}AIRTABLE/aa/inside.jpg` });
      await createAsset({
        workbookId,
        dataFolderId,
        url: `${otherWorkbookPublicUrlPrefix}AIRTABLE/aa/not-rehosted.jpg`,
      });
      expect(await countRehostedUrlsOutsideTheirOwnWorkbookKeyPrefix(db, publicUrlPrefix)).toBe(countBefore);

      // Under another workbook's prefix.
      await createAsset({
        workbookId,
        dataFolderId,
        rehostedUrl: `${otherWorkbookPublicUrlPrefix}AIRTABLE/aa/other-workbook.jpg`,
      });
      // Differs from this workbook's id only where a LIKE `_` wildcard would still match.
      const lookalikeWorkbookId = workbookId.replace('wkb_', 'wkbZ');
      await createAsset({
        workbookId,
        dataFolderId,
        rehostedUrl: `${publicUrlPrefix}v1/${lookalikeWorkbookId}/AIRTABLE/aa/lookalike.jpg`,
      });
      expect(await countRehostedUrlsOutsideTheirOwnWorkbookKeyPrefix(db, publicUrlPrefix)).toBe(countBefore + 2);

      await prisma.asset.deleteMany({ where: { dataFolderId } });
      expect(await countRehostedUrlsOutsideTheirOwnWorkbookKeyPrefix(db, publicUrlPrefix)).toBe(countBefore);
    });

    it('loads rehostedUrl and url references under a prefix from any workbook, without query strings or fragments', async () => {
      const dataFolderId = await createDataFolder(workbookId, 'References');
      const otherWorkbookDataFolderId = await createDataFolder(otherWorkbookId, 'References (other workbook)');
      const rehostedObjectUrl = `${workbookPublicUrlPrefix}AIRTABLE/bb/a.jpg`;
      const hotLinkedObjectUrl = `${workbookPublicUrlPrefix}AIRTABLE/bb/b.jpg`;
      await createAsset({ workbookId, dataFolderId, rehostedUrl: rehostedObjectUrl });
      // Copies of the same URL collapse to one entry.
      await createAsset({ workbookId, dataFolderId, rehostedUrl: rehostedObjectUrl });
      // A Notion-style hot-link indexed into `url` by a folder in ANOTHER workbook.
      await createAsset({
        workbookId: otherWorkbookId,
        dataFolderId: otherWorkbookDataFolderId,
        url: `${hotLinkedObjectUrl}?width=200#cover`,
      });
      // Under another workbook's prefix: not a reference to this prefix's objects.
      await createAsset({ workbookId, dataFolderId, rehostedUrl: `${otherWorkbookPublicUrlPrefix}AIRTABLE/bb/c.jpg` });

      const referencedPublicUrls = await loadAssetUrlsReferencingPublicUrlPrefix(db, workbookPublicUrlPrefix);

      expect([...referencedPublicUrls].sort()).toEqual([rehostedObjectUrl, hotLinkedObjectUrl].sort());
    });
  });
});
