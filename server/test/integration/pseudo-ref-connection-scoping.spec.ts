/**
 * Pseudo-ref connection scoping — DEV-10880
 *
 * Proves, against real PostgreSQL, that a canonical workspace-absolute pseudo-ref
 * (`@/<connection>/<folder>/<file>.json`) resolves to the RIGHT connection when two
 * connections in the same workbook expose an identically-named folder (the live
 * repro: two HubSpot connections both with a `Contacts` folder, keyed on a bare
 * connection-relative `folderPath` in FileIndex). Exercises the real
 * FileIndexService (connectorAccountId column + connection-scoped lookup) and
 * RefResolverService (connection-segment → connectorAccountId translation).
 */
import { PrismaClient } from '@prisma/client';
import { createConnectorAccountId, createWorkbookId, WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { RefResolverService } from 'src/publish-plan/ref-resolver.service';
import { Service } from 'src/remote-service/connectors/service-constants';

function makeDbService(prisma: PrismaClient): DbService {
  return { client: prisma } as unknown as DbService;
}

jest.setTimeout(60_000);

describe('Pseudo-ref connection scoping (DEV-10880)', () => {
  let prisma: PrismaClient;
  let fileIndexService: FileIndexService;
  let refResolverService: RefResolverService;

  let orgId: string;
  let userId: string;
  let workbookId: WorkbookId;
  let hubspotAccountId: string;
  let hubspotTestingAccountId: string;

  // Both connections have a `Contacts` folder with a same-named file, but distinct
  // record ids — the exact collision the discriminator resolves.
  const FOLDER = 'Contacts';
  const FILENAME = 'shared-contact.json';
  const HUBSPOT_RECORD_ID = 'contact_from_hubspot';
  const HUBSPOT_TESTING_RECORD_ID = 'contact_from_hubspot_testing';

  beforeAll(async () => {
    prisma = new PrismaClient();
    const dbService = makeDbService(prisma);
    fileIndexService = new FileIndexService(dbService);
    refResolverService = new RefResolverService(fileIndexService, dbService);

    const ts = Date.now();
    const org = await prisma.organization.create({
      data: { id: `org_prcs_${ts}`, name: 'PRCS Test Org', clerkId: `clerk_prcs_${ts}` },
    });
    orgId = org.id;
    const user = await prisma.user.create({
      data: { id: `user_prcs_${ts}`, email: `prcs-${ts}@example.com`, organizationId: org.id },
    });
    userId = user.id;
    workbookId = createWorkbookId();
    await prisma.workbook.create({
      data: { id: workbookId, name: 'PRCS Test Workbook', userId: user.id, organizationId: org.id },
    });

    hubspotAccountId = createConnectorAccountId();
    hubspotTestingAccountId = createConnectorAccountId();
    await prisma.connectorAccount.createMany({
      data: [
        { id: hubspotAccountId, workbookId, service: Service.HUBSPOT, displayName: 'HubSpot' },
        { id: hubspotTestingAccountId, workbookId, service: Service.HUBSPOT, displayName: 'HubSpot Testing' },
      ],
    });

    // Two FileIndex rows sharing folderPath+filename, scoped to different connections.
    await fileIndexService.upsertBatch([
      {
        workbookId,
        folderPath: FOLDER,
        filename: FILENAME,
        recordId: HUBSPOT_RECORD_ID,
        connectorAccountId: hubspotAccountId,
      },
      {
        workbookId,
        folderPath: FOLDER,
        filename: FILENAME,
        recordId: HUBSPOT_TESTING_RECORD_ID,
        connectorAccountId: hubspotTestingAccountId,
      },
    ]);
  });

  afterAll(async () => {
    if (workbookId) {
      await prisma.fileIndex.deleteMany({ where: { workbookId } });
      await prisma.connectorAccount.deleteMany({ where: { workbookId } });
      await prisma.workbook.delete({ where: { id: workbookId } }).catch(() => {});
    }
    if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('resolves a workspace-absolute ref to the HubSpot connection when publishing HubSpot', async () => {
    const [resolved] = await refResolverService.resolveBatchPseudoRefs(
      workbookId,
      [{ contactId: `@/HubSpot/${FOLDER}/${FILENAME}` }],
      undefined,
      hubspotAccountId,
    );
    expect(resolved).toEqual({ contactId: HUBSPOT_RECORD_ID });
  });

  it('resolves a workspace-absolute ref to the HubSpot Testing connection when publishing HubSpot Testing', async () => {
    const [resolved] = await refResolverService.resolveBatchPseudoRefs(
      workbookId,
      [{ contactId: `@/HubSpot Testing/${FOLDER}/${FILENAME}` }],
      undefined,
      hubspotTestingAccountId,
    );
    expect(resolved).toEqual({ contactId: HUBSPOT_TESTING_RECORD_ID });
  });

  it('routes by the connection SEGMENT, not the plan connection (cross-connection ref)', async () => {
    // Publishing HubSpot, but the ref names "HubSpot Testing" → must resolve there.
    const [resolved] = await refResolverService.resolveBatchPseudoRefs(
      workbookId,
      [{ contactId: `@/HubSpot Testing/${FOLDER}/${FILENAME}` }],
      undefined,
      hubspotAccountId,
    );
    expect(resolved).toEqual({ contactId: HUBSPOT_TESTING_RECORD_ID });
  });

  it('resolves a legacy connection-relative ref within the plan connection', async () => {
    const [resolved] = await refResolverService.resolveBatchPseudoRefs(
      workbookId,
      [{ contactId: `@/${FOLDER}/${FILENAME}` }],
      undefined,
      hubspotTestingAccountId,
    );
    expect(resolved).toEqual({ contactId: HUBSPOT_TESTING_RECORD_ID });
  });
});
