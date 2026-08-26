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

import { PartialBatchCreateError } from 'src/remote-service/connectors/error';
import { HubspotApiClient } from 'src/remote-service/connectors/library/hubspot/hubspot-api-client';
import { HubspotAssociationWriteError } from 'src/remote-service/connectors/library/hubspot/hubspot-batch-publish';
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

  // DEV-10200: the same associate → dissociate round-trip through the
  // date-versioned 2026-03 endpoints, proving the migration target behaves
  // identically against the real API before the flag ramps.
  it('associates and dissociates via the 2026-03 API', async () => {
    const suffix = Date.now();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const dbvConnector = new HubspotConnector(API_KEY!, { associationsApiVersion: '2026-03' });

    const [company] = await dbvConnector.createRecords(companiesSpec, [
      { properties: { name: `Scratch DBV Co ${suffix}` } } as ConnectorFile,
    ]);
    const companyId = String((company as { id: unknown }).id);
    cleanups.push(async () => {
      await connector.deleteRecords(companiesSpec, [{ id: companyId } as ConnectorFile]);
    });

    const [contact] = await dbvConnector.createRecords(contactsSpec, [
      { properties: { email: `scratch-dbv-${suffix}@example.com` } } as ConnectorFile,
    ]);
    const contactId = String((contact as { id: unknown }).id);
    cleanups.push(async () => {
      await connector.deleteRecords(contactsSpec, [{ id: contactId } as ConnectorFile]);
    });

    const desiredAssociations = { companies: { results: [{ id: companyId }] } };
    await dbvConnector.updateRecords(
      contactsSpec,
      [{ ...contact, associations: desiredAssociations }],
      [{ associations: desiredAssociations }],
    );
    expect(associatedIds(await refetch(contactsSpec, contactId), 'companies')).toContain(companyId);

    const clearedAssociations = { companies: { results: [] as { id: string }[] } };
    await dbvConnector.updateRecords(
      contactsSpec,
      [{ ...contact, associations: clearedAssociations }],
      [{ associations: clearedAssociations }],
    );
    expect(associatedIds(await refetch(contactsSpec, contactId), 'companies')).not.toContain(companyId);
  });
});

// DEV-10200 phase 2: prove the REAL contract of the batch endpoints the batched
// publish path (HUBSPOT_BATCH_PUBLISH) relies on. The fake models these from
// HubSpot's docs; only this suite can confirm the shapes against the portal:
//   - batch/create results come back in ARBITRARY order but each echoes its
//     input's objectWriteTraceId (the create path binds results to files by
//     that echo; a wrong binding would tie a file to someone else's record);
//   - a 207 body names rejected inputs in errors[].context.objectWriteTraceId;
//   - batch/associate/default takes pairs from different records in one call;
//   - batch/archive removes every association type, like the single DELETE;
//   - the shape of a batch association error for a bogus `to` id.
// The raw bodies of anything unexpected are printed (console.debug) so the
// plan doc can record the exact contract.
describeIfKey('HubspotConnector — live API (batch publishing contract, DEV-10200)', () => {
  let batchConnector: HubspotConnector;
  let legacyConnector: HubspotConnector;
  let contactsSpec: BaseJsonTableSpec;
  let companiesSpec: BaseJsonTableSpec;
  const cleanups: (() => Promise<void>)[] = [];

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    batchConnector = new HubspotConnector(API_KEY!, { batchPublish: true, associationsApiVersion: '2026-03' });
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    legacyConnector = new HubspotConnector(API_KEY!);
    const tables: TablePreview[] = await batchConnector.listTables();
    const contacts = tables.find((t) => t.id.remoteId[0] === 'contacts');
    const companies = tables.find((t) => t.id.remoteId[0] === 'companies');
    if (!contacts || !companies) {
      throw new Error('Expected the HubSpot portal to expose contacts and companies tables');
    }
    contactsSpec = await batchConnector.fetchJsonTableSpec(contacts.id);
    companiesSpec = await batchConnector.fetchJsonTableSpec(companies.id);
  });

  afterAll(async () => {
    await Promise.allSettled(cleanups.map((fn) => fn()));
  });

  function idOf(file: ConnectorFile | undefined): string {
    return String((file as { id: unknown } | undefined)?.id);
  }

  function emailOf(file: ConnectorFile | undefined): string | undefined {
    return (file as { properties?: { email?: string } } | undefined)?.properties?.email?.toLowerCase();
  }

  function scheduleContactCleanup(contactId: string): void {
    cleanups.push(async () => {
      await legacyConnector.deleteRecords(contactsSpec, [{ id: contactId } as ConnectorFile]);
    });
  }

  async function refetch(spec: BaseJsonTableSpec, id: string): Promise<ConnectorFile | undefined> {
    const pulled: ConnectorFile[] = [];
    await legacyConnector.pullRecordFilesByIds(spec, [id], ({ files }) => {
      pulled.push(...files);
      return Promise.resolve();
    });
    return pulled[0];
  }

  it('batch/create: each file gets its own record even though HubSpot returns results in arbitrary order (observed: reversed)', async () => {
    const suffix = Date.now();
    const emails = [0, 1, 2].map((n) => `scratch-batch-${suffix}-${n}@example.com`);

    const created = await batchConnector.createRecords(
      contactsSpec,
      emails.map((email) => ({ properties: { email } }) as ConnectorFile),
    );
    created.forEach((file) => scheduleContactCleanup(idOf(file)));

    expect(created.map(emailOf)).toEqual(emails);
  });

  it("batch/create echoes each input's objectWriteTraceId on its result (201 and 207), for contacts and companies", async () => {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const client = new HubspotApiClient(API_KEY!);
    const suffix = Date.now();
    const traceIds = ['zeta', 'alpha', '7'];
    const inputs = traceIds.map((objectWriteTraceId, index) => ({
      objectWriteTraceId,
      properties: { email: `scratch-trace-${suffix}-${index}@example.com`, lastname: objectWriteTraceId },
    }));

    const response = await client.batchCreateRecords('contacts', inputs);
    for (const created of response.results) scheduleContactCleanup(created.id);
    expect(response.status).toBe('COMPLETE');
    expect(response.results).toHaveLength(3);
    // Each result's trace id is the one sent for the input whose values it carries.
    for (const created of response.results) expect(created.objectWriteTraceId).toBe(created.properties.lastname);
    expect(new Set(response.results.map((created) => created.objectWriteTraceId))).toEqual(new Set(traceIds));

    const partial = await client.batchCreateRecords('contacts', [
      { objectWriteTraceId: 'ok', properties: { email: `scratch-trace-${suffix}-ok@example.com` } },
      { objectWriteTraceId: 'bad', properties: { email: 'not-an-email' } },
    ]);
    for (const created of partial.results) scheduleContactCleanup(created.id);
    expect(partial.results.map((created) => created.objectWriteTraceId)).toEqual(['ok']);
    expect(partial.errors?.[0]?.context?.objectWriteTraceId).toEqual(['bad']);

    const company = await client.batchCreateRecords('companies', [
      { objectWriteTraceId: 'co', properties: { name: `Scratch Trace Co ${suffix}` } },
    ]);
    const companyId = company.results[0].id;
    cleanups.push(async () => {
      await legacyConnector.deleteRecords(companiesSpec, [{ id: companyId } as ConnectorFile]);
    });
    expect(company.results[0].objectWriteTraceId).toBe('co');
  });

  it('batch/create with one invalid input answers 207: valid inputs are created, the error names the trace id, and the results bind to the right files', async () => {
    const suffix = Date.now();
    const files = [
      { properties: { email: `scratch-207-${suffix}-a@example.com` } },
      { properties: { email: 'not-an-email' } },
      { properties: { email: `scratch-207-${suffix}-c@example.com` } },
    ] as ConnectorFile[];

    let thrown: unknown;
    await batchConnector.createRecords(contactsSpec, files).catch((error: unknown) => (thrown = error));
    if (!(thrown instanceof PartialBatchCreateError)) {
      // Print whatever HubSpot did instead so the plan doc can record it.
      console.debug('batch/create with an invalid input did NOT produce a partial failure:', thrown);
      throw thrown ?? new Error('Expected a PartialBatchCreateError');
    }
    for (const created of thrown.createdRecordsByInputIndex.values()) scheduleContactCleanup(idOf(created));

    expect([...thrown.createdRecordsByInputIndex.keys()]).toEqual([0, 2]);
    expect(emailOf(thrown.createdRecordsByInputIndex.get(0))).toBe(`scratch-207-${suffix}-a@example.com`);
    expect(emailOf(thrown.createdRecordsByInputIndex.get(2))).toBe(`scratch-207-${suffix}-c@example.com`);
    expect([...thrown.failureMessagesByInputIndex.keys()]).toEqual([1]);
    console.debug('HubSpot 207 failure message for the invalid input:', thrown.failureMessagesByInputIndex.get(1));
    expect(thrown.failureMessagesByInputIndex.get(1)).toMatch(/objectWriteTraceId=1/);
  });

  it('batch/associate/default links pairs from different records in one call; batch/archive removes every association type like the single DELETE', async () => {
    const suffix = Date.now();
    const [company] = await legacyConnector.createRecords(companiesSpec, [
      { properties: { name: `Scratch Batch Co ${suffix}` } } as ConnectorFile,
    ]);
    const companyId = idOf(company);
    cleanups.push(async () => {
      await legacyConnector.deleteRecords(companiesSpec, [{ id: companyId } as ConnectorFile]);
    });
    const contacts = await legacyConnector.createRecords(
      contactsSpec,
      [0, 1].map((n) => ({ properties: { email: `scratch-assoc-${suffix}-${n}@example.com` } }) as ConnectorFile),
    );
    contacts.forEach((file) => scheduleContactCleanup(idOf(file)));

    // Link both contacts to the company in one batched update (one associate call).
    const linked = { companies: { results: [{ id: companyId }] } };
    await batchConnector.updateRecords(
      contactsSpec,
      contacts.map((contact) => ({ ...contact, associations: linked })),
      contacts.map(() => ({ associations: linked })),
    );
    for (const contact of contacts) {
      const pulled = await refetch(contactsSpec, idOf(contact));
      expect(associatedIds(pulled, 'companies')).toContain(companyId);
    }

    // Unlink both in one batched update (one archive call). The default
    // contact→company association carries HubSpot's primary AND unlabeled
    // types; the refetch must show NO companies link at all, proving the
    // archive removed every type (the id-only diff depends on that).
    const unlinked = { companies: { results: [] as { id: string }[] } };
    await batchConnector.updateRecords(
      contactsSpec,
      contacts.map((contact) => ({ ...contact, associations: unlinked })),
      contacts.map(() => ({ associations: unlinked })),
    );
    for (const contact of contacts) {
      const pulled = await refetch(contactsSpec, idOf(contact));
      expect(associatedIds(pulled, 'companies')).not.toContain(companyId);
    }
  });

  it('batch/associate/default with a bogus `to` id is surfaced as an association write error naming the pair (prints the raw body)', async () => {
    const suffix = Date.now();
    const [contact] = await legacyConnector.createRecords(contactsSpec, [
      { properties: { email: `scratch-bogus-${suffix}@example.com` } } as ConnectorFile,
    ]);
    const contactId = idOf(contact);
    scheduleContactCleanup(contactId);

    const bogusCompanyId = '999999999999';
    const desired = { companies: { results: [{ id: bogusCompanyId }] } };
    let thrown: unknown;
    await batchConnector
      .updateRecords(contactsSpec, [{ ...contact, associations: desired }], [{ associations: desired }])
      .catch((error: unknown) => (thrown = error));

    if (thrown instanceof HubspotAssociationWriteError) {
      console.debug('HubSpot batch association error body:', JSON.stringify(thrown.responseData));
      expect(thrown.failedPairs.map((pair) => `${pair.fromId}→${pair.toId}`)).toEqual([
        `${contactId}→${bogusCompanyId}`,
      ]);
    } else {
      // HubSpot may reject the whole call (4xx) instead of answering 207 —
      // record which, since the connector handles both; either way the
      // failure must be surfaced, never swallowed.
      console.debug('HubSpot rejected the batch association call outright:', thrown);
      expect(thrown).toBeInstanceOf(Error);
    }
  });
});
