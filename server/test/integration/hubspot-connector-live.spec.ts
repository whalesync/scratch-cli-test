/**
 * HubSpot connector LIVE API integration test — associations round-trip (DEV-10847).
 *
 * Unlike `hubspot-connector.spec.ts` (which runs against the in-process fake), this
 * suite drives the REAL HubSpot CRM v3/v4 API to prove the association WRITE path
 * end-to-end: create two records, associate them (the same `associations.<type>.results`
 * shape the grid packs an edited FK list into), verify via a fresh pull, then
 * dissociate and verify removal. Everything created is torn down in `afterAll`.
 *
 * Requires HUBSPOT_API_KEY in .env.integration — a Private App access token
 * (`pat-na1-…`) with `crm.objects.contacts` + `crm.objects.companies` read & write
 * scopes. The suite self-skips (describe.skip) when the key is absent, so CI stays
 * green until a test portal token is provisioned.
 *
 * Run via: cd server && yarn test:integration -- hubspot-connector-live
 */

// Break the circular import chain that pulls in display-names → registry → DB.
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { HubspotConnector } from 'src/remote-service/connectors/library/hubspot/hubspot-connector';
import { BaseJsonTableSpec, ConnectorFile, TablePreview } from 'src/remote-service/connectors/types';

jest.setTimeout(60_000);

const API_KEY = process.env.HUBSPOT_API_KEY;

// Skip the entire suite if no key is configured (so CI stays green).
const describeIfKey = API_KEY ? describe : describe.skip;

/** The association shape a record file carries under `associations.<type>`. */
type AssociationResults = { results?: { id: string; type?: string }[] };
type RecordAssociations = { associations?: Record<string, AssociationResults> };

/** Pull the associated ids for one related type out of a pulled record file. */
function associatedIds(record: ConnectorFile | undefined, relatedType: string): string[] {
  const results = (record as RecordAssociations | undefined)?.associations?.[relatedType]?.results ?? [];
  return results.map((r) => r.id);
}

describeIfKey('HubspotConnector — live API (associations)', () => {
  let connector: HubspotConnector;
  let contactsSpec: BaseJsonTableSpec;
  let companiesSpec: BaseJsonTableSpec;
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    connector = new HubspotConnector(API_KEY!);
    const tables: TablePreview[] = await connector.listTables();
    const contacts = tables.find((t) => t.id.remoteId[0] === 'contacts');
    const companies = tables.find((t) => t.id.remoteId[0] === 'companies');
    if (!contacts || !companies) {
      throw new Error('Expected the HubSpot portal to expose contacts and companies tables');
    }
    contactsSpec = await connector.fetchJsonTableSpec(contacts.id);
    companiesSpec = await connector.fetchJsonTableSpec(companies.id);
  });

  afterAll(async () => {
    await Promise.allSettled(cleanups.map((fn) => fn()));
  });

  /** Re-pull a single record (associations included) to read authoritative state. */
  async function refetch(spec: BaseJsonTableSpec, id: string): Promise<ConnectorFile | undefined> {
    const pulled: ConnectorFile[] = [];
    await connector.pullRecordFilesByIds(spec, [id], ({ files }) => {
      pulled.push(...files);
      return Promise.resolve();
    });
    return pulled[0];
  }

  it('validates credentials against the live API', async () => {
    await expect(connector.testConnection()).resolves.toBeUndefined();
  });

  it('rejects an obviously invalid token', async () => {
    const badConnector = new HubspotConnector('pat-na1-not-a-real-token');
    await expect(badConnector.testConnection()).rejects.toThrow();
  });

  it('associates a contact to a company via publish, then dissociates — verified by a fresh pull', async () => {
    const suffix = Date.now();

    // 1. Create a company and a contact; queue both for teardown.
    const [company] = await connector.createRecords(companiesSpec, [
      { properties: { name: `Scratch IT Co ${suffix}` } } as ConnectorFile,
    ]);
    const companyId = String((company as { id: unknown }).id);
    cleanups.push(async () => {
      await connector.deleteRecords(companiesSpec, [{ id: companyId } as ConnectorFile]);
    });

    const [contact] = await connector.createRecords(contactsSpec, [
      { properties: { email: `scratch-it-${suffix}@example.com` } } as ConnectorFile,
    ]);
    const contactId = String((contact as { id: unknown }).id);
    cleanups.push(async () => {
      await connector.deleteRecords(contactsSpec, [{ id: contactId } as ConnectorFile]);
    });

    // Sanity: no company association yet.
    expect(associatedIds(await refetch(contactsSpec, contactId), 'companies')).not.toContain(companyId);

    // 2. Associate contact → company. This is exactly the shape the grid packs an
    //    edited FK list into: `associations.companies.results = [{ id }]`. Scope the
    //    changedFields to `associations` so only the v4 association sync runs.
    const desiredAssociations = { companies: { results: [{ id: companyId }] } };
    await connector.updateRecords(
      contactsSpec,
      [{ ...contact, associations: desiredAssociations }],
      [{ associations: desiredAssociations }],
    );

    // 3. Verify the link exists on a fresh pull (v4 read via pullRecordFilesByIds).
    expect(associatedIds(await refetch(contactsSpec, contactId), 'companies')).toContain(companyId);

    // 4. Dissociate: an empty `results` array removes the link (the delete half of
    //    syncAssociations).
    const clearedAssociations = { companies: { results: [] as { id: string }[] } };
    await connector.updateRecords(
      contactsSpec,
      [{ ...contact, associations: clearedAssociations }],
      [{ associations: clearedAssociations }],
    );

    // 5. Verify removal.
    expect(associatedIds(await refetch(contactsSpec, contactId), 'companies')).not.toContain(companyId);
  });
});
