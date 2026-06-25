/**
 * GoHighLevel (HighLevel) connector live-API integration test.
 *
 * Connector-build Milestone 10 (DEV-10304). Validates the four capabilities against
 * the live LeadConnector API: get schemas, pull, publish (CRUD), handle errors.
 *
 * State model: SELF-PROVISIONING — the CRUD suite creates a Contact, reads it back,
 * updates it, and deletes it, with best-effort `afterAll` cleanup. Contacts is the
 * safe round-trip target (create needs only name/email); Opportunities are exercised
 * read-only here because creating one requires an existing pipeline + stage + contact
 * (a heavier fixture — left for a follow-up).
 *
 * Requires GOHIGHLEVEL_API_TOKEN (a Private Integration Token, `pit-...`) and
 * GOHIGHLEVEL_LOCATION_ID in .env.integration. Use a DEDICATED test sub-account
 * (Location) — the CRUD suite writes real contacts. The token needs read+write scopes
 * for contacts (+ opportunities/objects/customFields read for discovery). See
 * gohighlevel/STATE.md → Test account.
 *
 * NB (from STATE.md): GHL `GET /contacts/{id}` 400s ("not found") for a JUST-created
 * contact (read-after-write lag), so the CREATE read-back uses the search-backed full
 * pull (`pullRecordFiles`) with a poll for eventual consistency. Once the record exists,
 * get-by-id is the reliable, INSTANT read (no search-index lag), so the UPDATE and DELETE
 * read-backs use get-by-id (`pullRecordFilesByIds`) — this is what keeps the update
 * assertion from flaking on slow search reindexing. Watch the historical "contact create
 * returns no remote id" flag.
 *
 * ⚠️ SCAFFOLD — written from the connector code + STATE.md; not yet live-run (no token
 * at authoring time). Confirm green against a real Location before flipping STATE.md
 * Milestone 10 / the docs IT columns to ✅.
 *
 * Run via: cd server && yarn test:integration -- gohighlevel-connector
 */

// Break the circular import chain through connectors/display-names.
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { GoHighLevelConnector } from 'src/remote-service/connectors/library/gohighlevel/gohighlevel-connector';
import { BaseJsonTableSpec, ConnectorFile, TablePreview } from 'src/remote-service/connectors/types';

const API_TOKEN = process.env.GOHIGHLEVEL_API_TOKEN;
const LOCATION_ID = process.env.GOHIGHLEVEL_LOCATION_ID ?? '';

const TEST_PREFIX = `scratch-it-${Date.now()}`;

jest.setTimeout(120_000);

// API_TOKEN is defined whenever this runs: the suite is gated on describeIfCreds (API_TOKEN && LOCATION_ID).
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
function createConnector(token = API_TOKEN!): GoHighLevelConnector {
  return new GoHighLevelConnector(token, LOCATION_ID);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Pull every contact via the search-backed full pull (the reliable read path —
 * GHL's get-by-id 400s right after create and omits fields). */
async function pullAllContacts(connector: GoHighLevelConnector, spec: BaseJsonTableSpec): Promise<ConnectorFile[]> {
  const files: ConnectorFile[] = [];
  await connector.pullRecordFiles(
    spec,
    async ({ files: batch }) => {
      files.push(...batch);
      return Promise.resolve();
    },
    {},
    {},
  );
  return files;
}

/** Poll the search-backed pull until `predicate` matches a contact (eventual
 * consistency: a just-written contact can take a moment to be searchable). */
async function waitForContact(
  connector: GoHighLevelConnector,
  spec: BaseJsonTableSpec,
  predicate: (c: Record<string, unknown>) => boolean,
  { tries = 20, delayMs = 3000 } = {},
): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const match = (await pullAllContacts(connector, spec)).find((c) => predicate(c as Record<string, unknown>));
    if (match) return match as Record<string, unknown>;
    await sleep(delayMs);
  }
  return null;
}

/**
 * Fetch a single contact by id via the connector's get-by-id path
 * (`pullRecordFilesByIds`). Unlike the search-backed pull, this reads the record
 * directly, so it reflects a write immediately — no search-index lag. Returns
 * null when GHL reports the contact gone (get-by-id 404s after a delete).
 */
async function getContactById(
  connector: GoHighLevelConnector,
  spec: BaseJsonTableSpec,
  id: string,
): Promise<Record<string, unknown> | null> {
  const files: ConnectorFile[] = [];
  await connector.pullRecordFilesByIds(spec, [id], async ({ files: batch }) => {
    files.push(...batch);
    return Promise.resolve();
  });
  return (files[0] as Record<string, unknown> | undefined) ?? null;
}

/**
 * Poll get-by-id until `predicate` holds — confirms an UPDATE landed. The record
 * already exists, so get-by-id returns it with the new value on the first try in
 * practice; the retries only guard a transient hiccup. (Create can't use this:
 * GHL's get-by-id 400s for a just-created contact, so it uses the search poll.)
 */
async function waitByIdUntil(
  connector: GoHighLevelConnector,
  spec: BaseJsonTableSpec,
  id: string,
  predicate: (c: Record<string, unknown>) => boolean,
  { tries = 15, delayMs = 2000 } = {},
): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < tries; attempt++) {
    const record = await getContactById(connector, spec, id);
    if (record && predicate(record)) return record;
    await sleep(delayMs);
  }
  return null;
}

/** Poll get-by-id until the contact is gone (404 → null) — confirms a DELETE. */
async function waitByIdUntilGone(
  connector: GoHighLevelConnector,
  spec: BaseJsonTableSpec,
  id: string,
  { tries = 15, delayMs = 2000 } = {},
): Promise<boolean> {
  for (let attempt = 0; attempt < tries; attempt++) {
    if ((await getContactById(connector, spec, id)) === null) return true;
    await sleep(delayMs);
  }
  return false;
}

const describeIfCreds = API_TOKEN && LOCATION_ID ? describe : describe.skip;

describeIfCreds('GoHighLevelConnector — live API', () => {
  let connector: GoHighLevelConnector;
  let allTables: TablePreview[];
  let contactsSpec: BaseJsonTableSpec;

  beforeAll(async () => {
    connector = createConnector();
    allTables = await connector.listTables();
    const contacts = allTables.find((t) => t.id.wsId === 'contacts');
    if (!contacts) throw new Error('Contacts table not found — check the token/location.');
    contactsSpec = await connector.fetchJsonTableSpec(contacts.id);
  });

  // --- Connection / errors ---
  describe('testConnection', () => {
    it('validates credentials against the live API', async () => {
      await expect(connector.testConnection()).resolves.toBeUndefined();
    });

    it('rejects an obviously invalid token', async () => {
      const bad = createConnector('pit-not-a-real-token');
      await expect(bad.testConnection()).rejects.toThrow();
    });
  });

  // --- Schema discovery ---
  describe('listTables', () => {
    it('exposes Contacts + Opportunities (writable) and Pipelines (read-only)', () => {
      const byWsId = new Map(allTables.map((t) => [t.id.wsId, t]));
      expect(byWsId.has('contacts')).toBe(true);
      expect(byWsId.has('opportunities')).toBe(true);
      const pipelines = byWsId.get('pipelines');
      expect(pipelines?.disabledCreates).toBe(true);
      expect(pipelines?.disabledUpdates).toBe(true);
      expect(pipelines?.disabledDeletes).toBe(true);
    });

    it('exposes Calendars as writable (a location-list entity with full CRUD)', () => {
      const calendars = allTables.find((t) => t.id.wsId === 'calendars');
      expect(calendars).toBeDefined();
      // No write flags set → isTableFullyLocked stays false → the picker/grid offers
      // editing instead of forcing the folder read-only.
      expect(calendars?.disabledCreates).toBeUndefined();
      expect(calendars?.disabledUpdates).toBeUndefined();
      expect(calendars?.disabledDeletes).toBeUndefined();
    });
  });

  describe('fetchJsonTableSpec (contacts)', () => {
    it('builds a contacts spec with an `id` id-column and standard fields', () => {
      expect(contactsSpec.idPath).toBe('id');
      const props = (contactsSpec.schema as unknown as { properties: Record<string, unknown> }).properties;
      expect(props).toHaveProperty('id');
      expect(Object.keys(props).length).toBeGreaterThan(0);
    });

    it('throws for an unknown table id', async () => {
      await expect(
        connector.fetchJsonTableSpec({ wsId: 'definitely-not-a-table', remoteId: ['definitely-not-a-table'] }),
      ).rejects.toThrow();
    });
  });

  // --- Pull ---
  describe('pullRecordFiles (contacts)', () => {
    it('streams contact records carrying a string id', async () => {
      const files: ConnectorFile[] = [];
      await connector.pullRecordFiles(
        contactsSpec,
        async ({ files: batch }) => {
          files.push(...batch);
          return Promise.resolve();
        },
        {},
        {},
      );
      for (const file of files.slice(0, 5)) {
        expect(typeof file.id).toBe('string');
      }
    });
  });

  // --- Publish (CRUD round-trip) — self-provisioning ---
  describe('contacts create → update → delete', () => {
    const createdIds: string[] = [];

    afterAll(async () => {
      for (const id of createdIds) {
        try {
          await connector.deleteRecords(contactsSpec, [{ id } as ConnectorFile]);
        } catch {
          // best-effort
        }
      }
    });

    it('creates a contact, reads it back, updates it, then deletes it', async () => {
      const email = `${TEST_PREFIX}@example.com`;
      const [created] = await connector.createRecords(contactsSpec, [
        { firstName: 'Scratch', lastName: 'IntegrationTest', email },
      ]);
      // STATE.md flag: contact create must return a remote id. If this is null/empty,
      // the historical "create returns no remote id" bug has regressed.
      const contactId = (created as Record<string, unknown>).id as string;
      expect(typeof contactId).toBe('string');
      expect(contactId.length).toBeGreaterThan(0);
      createdIds.push(contactId);

      const afterCreate = await waitForContact(connector, contactsSpec, (c) => c.id === contactId);
      expect(afterCreate).not.toBeNull();
      expect(afterCreate?.firstName).toBe('Scratch');

      await connector.updateRecords(contactsSpec, [{ id: contactId } as ConnectorFile], [{ lastName: 'Renamed' }]);
      // get-by-id reads the record directly (no search-index lag), so the update is
      // visible immediately — this is the read path that stops the flake.
      const afterUpdate = await waitByIdUntil(connector, contactsSpec, contactId, (c) => c.lastName === 'Renamed');
      expect(afterUpdate).not.toBeNull();

      await connector.deleteRecords(contactsSpec, [{ id: contactId } as ConnectorFile]);
      const gone = await waitByIdUntilGone(connector, contactsSpec, contactId);
      expect(gone).toBe(true);
    });
  });
});
