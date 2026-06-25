/**
 * Zoho CRM connector live API integration test.
 *
 * Exercises the real Zoho CRM v8 API through the actual ZohoConnector: refreshes
 * an access token, lists modules as tables (applying the eligibility policy),
 * builds schemas from live field metadata, pulls records (full + incremental),
 * and — when pointed at an org with create headroom — runs create→read→update→
 * delete round-trips that load each test record with one value of every standard
 * field type, plus a lookup-FK round-trip and a datetime/timezone round-trip.
 *
 * Requires ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN (+ optional
 * ZOHO_DATA_CENTER) in server/.env.integration.
 *
 * The create/update/delete suites are gated behind ZOHO_ALLOW_CREATE=1 because a
 * shared org can be at its record-storage cap (free edition → `MAX_LIMIT_REACHED`
 * on every POST). Point the creds at a green-field org and set the flag to run
 * full CRUD. The read-only suite always runs.
 *
 * Run via: cd server && yarn test:integration -- zoho-connector
 */

// Break the circular import chain: connector.ts → display-names.ts → registry →
// every connector → connector.ts (same shim the Pipedrive/Attio live tests use).
jest.mock('src/remote-service/connectors/display-names', () => ({
  getServiceDisplayName: (service: string) => service,
}));

import { X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { ZohoConnector } from 'src/remote-service/connectors/library/zoho/zoho-connector';
import { ZohoDataCenter } from 'src/remote-service/connectors/library/zoho/zoho-types';
import {
  BaseJsonTableSpec,
  ConnectorFile,
  PullRecordFilesOptions,
  PullRecordFilesResult,
  TablePreview,
} from 'src/remote-service/connectors/types';

jest.setTimeout(180_000);

const CLIENT_ID = process.env.ZOHO_CLIENT_ID;
const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
const DATA_CENTER = (process.env.ZOHO_DATA_CENTER ?? 'US') as ZohoDataCenter;

const HAS_CREDS = Boolean(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN);
const describeIfCreds = HAS_CREDS ? describe : describe.skip;
// Create/update/delete need an org with storage headroom (see header).
const describeCreate = HAS_CREDS && process.env.ZOHO_ALLOW_CREATE === '1' ? describe : describe.skip;

const NAME_PREFIX = 'ScratchIT'; // tag for find/cleanup of test records

function createConnector(): ZohoConnector {
  return new ZohoConnector({
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    clientId: CLIENT_ID!,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    clientSecret: CLIENT_SECRET!,
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    refreshToken: REFRESH_TOKEN!,
    dataCenter: DATA_CENTER,
  });
}

// ===========================================================================
// Suite 1 — read-only smoke: connection, discovery, schema, pull
// ===========================================================================

describeIfCreds('ZohoConnector — live API (read-only)', () => {
  let connector: ZohoConnector;
  let allTables: TablePreview[];
  let leadsTable: TablePreview;
  let leadsSpec: BaseJsonTableSpec;

  beforeAll(async () => {
    connector = createConnector();
    allTables = await connector.listTables();
    const found = allTables.find((t) => t.id.wsId === 'Leads');
    if (!found) throw new Error(`Expected a "Leads" table — got ${allTables.map((t) => t.id.wsId).join(', ')}`);
    leadsTable = found;
    leadsSpec = await connector.fetchJsonTableSpec(leadsTable.id);
  });

  describe('testConnection', () => {
    it('validates credentials against the live API', async () => {
      await expect(connector.testConnection()).resolves.toBeUndefined();
    });

    it('rejects bad credentials (token refresh fails)', async () => {
      const bad = new ZohoConnector({
        clientId: 'bad',
        clientSecret: 'bad',
        refreshToken: 'bad',
        dataCenter: DATA_CENTER,
      });
      await expect(bad.testConnection()).rejects.toThrow();
    });
  });

  describe('listTables — eligibility policy', () => {
    it('exposes the core writable modules and excludes api_supported=false ones', () => {
      const wsIds = new Set(allTables.map((t) => t.id.wsId));
      for (const expected of ['Leads', 'Contacts', 'Accounts', 'Deals', 'Tasks', 'Events', 'Calls']) {
        expect(wsIds.has(expected)).toBe(true);
      }
      // Home / Activities / Reports are api_supported=false and must be filtered out.
      for (const excluded of ['Home', 'Activities', 'Reports', 'Feeds', 'Emails']) {
        expect(wsIds.has(excluded)).toBe(false);
      }
    });

    it('flags read-only system modules as not creatable/editable/deletable', () => {
      // DealHistory (Stage History) is api_supported but C/E/D = false.
      const dealHistory = allTables.find((t) => t.id.wsId === 'DealHistory');
      if (dealHistory) {
        expect(dealHistory.disabledCreates).toBe(true);
        expect(dealHistory.disabledUpdates).toBe(true);
        expect(dealHistory.disabledDeletes).toBe(true);
      }
      // Writable modules carry no disabled markers.
      expect(leadsTable.disabledCreates).toBeUndefined();
    });

    it('groups modules into category parentPaths', () => {
      expect(leadsTable.parentPath).toBe('Sales');
      const tasks = allTables.find((t) => t.id.wsId === 'Tasks');
      expect(tasks?.parentPath).toBe('Activities');
    });
  });

  describe('fetchJsonTableSpec — schema from live field metadata', () => {
    it('builds a Leads spec with id read-only and Modified_Time as the last-modified field', () => {
      const props = schemaProps(leadsSpec);
      expect(props).toHaveProperty('id');
      expect((props.id as Record<string, unknown>)[X_SCRATCH_READONLY]).toBe(true);

      const modified = props.Modified_Time as Record<string, unknown>;
      expect(modified['x-scratch-last-modified-field']).toBe(true);
      expect(modified[X_SCRATCH_READONLY]).toBe(true);

      expect(leadsSpec.idPath).toBe('id');
      expect(leadsSpec.titlePath).toEqual('Last_Name');
    });

    it('annotates the Owner ownerlookup as a foreign key to users', () => {
      const owner = schemaProps(leadsSpec).Owner as Record<string, unknown>;
      expect(owner[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'users' });
    });

    it('builds a non-empty schema with an id for every core entity', async () => {
      for (const wsId of ['Contacts', 'Accounts', 'Deals', 'Tasks']) {
        const table = allTables.find((t) => t.id.wsId === wsId);
        if (!table) throw new Error(`Missing table ${wsId}`);
        const spec = await connector.fetchJsonTableSpec(table.id);
        const props = schemaProps(spec);
        expect(Object.keys(props).length).toBeGreaterThan(0);
        expect(props).toHaveProperty('id');
      }
    });
  });

  describe('pullRecordFiles', () => {
    it('streams Leads, each a verbatim record carrying a string id', async () => {
      const { files } = await pullAll(connector, leadsSpec, { pullMode: 'full' });
      for (const file of files) {
        expect(typeof file.id).toBe('string');
      }
      console.log(`\nZoho full pull: ${files.length} Leads\n`);
    });

    it('incremental pull issues a fresh watermark', async () => {
      const since = new Date(Date.now() - 5 * 60_000);
      const { result } = await pullAll(connector, leadsSpec, { pullMode: 'incremental', since });
      expect(result.newWatermark === undefined || result.newWatermark instanceof Date).toBe(true);
    });
  });
});

// ===========================================================================
// Suite 2 — Leads CRUD round-trip with every standard field type
// ===========================================================================

describeCreate('ZohoConnector — Leads CRUD + field types', () => {
  let connector: ZohoConnector;
  let spec: BaseJsonTableSpec;
  const createdIds: string[] = [];

  beforeAll(async () => {
    connector = createConnector();
    const tables = await connector.listTables();
    const found = tables.find((t) => t.id.wsId === 'Leads');
    if (!found) throw new Error('No Leads table');
    spec = await connector.fetchJsonTableSpec(found.id);
  });

  afterAll(async () => {
    if (createdIds.length) {
      await connector
        .deleteRecords(
          spec,
          createdIds.map((id) => ({ id }) as unknown as ConnectorFile),
        )
        .catch(() => undefined);
    }
  });

  it('creates a Lead with each standard field type, reads every value back, updates, then deletes', async () => {
    const suffix = `${Date.now()}`;
    const unicode = 'テスト ünïcödé — emoji & unicode 🎯';
    const longText = 'L'.repeat(2000);

    const payload: Record<string, unknown> = {
      Last_Name: `${NAME_PREFIX} ${suffix}`, // text (title)
      Company: `${NAME_PREFIX} Co`, // text (required)
      Description: `${unicode}\nsecond line\n${longText}`, // textarea + unicode + emoji + long
      Email: `scratch+${suffix}@example.com`, // email
      Phone: '+1-555-0142', // phone
      Website: 'https://scratch.example.com', // website/uri
      Lead_Source: 'Cold Call', // picklist (literal value)
      Lead_Status: 'Contacted', // picklist
      Email_Opt_Out: true, // boolean
      No_of_Employees: 4242, // integer
      Annual_Revenue: 987654, // currency
    };

    // ── Create ──
    const [created] = await connector.createRecords(spec, [payload as ConnectorFile]);
    const id = String((created as Record<string, unknown>).id);
    expect(id).toMatch(/^\d+$/); // Zoho bigint id as string
    createdIds.push(id);

    // ── Read back via the connector's own by-id fetch ──
    const r = (await fetchById(connector, spec, id)) as Record<string, unknown>;
    expect(r).not.toBeNull();
    expect(r.Last_Name).toBe(payload.Last_Name); // text
    expect(r.Email).toBe(payload.Email); // email
    expect(r.Phone).toBe(payload.Phone); // phone
    expect(r.Website).toBe(payload.Website); // website
    expect(r.Lead_Source).toBe('Cold Call'); // picklist = literal label (no id↔label)
    expect(r.Lead_Status).toBe('Contacted');
    expect(r.Email_Opt_Out).toBe(true); // boolean
    expect(r.No_of_Employees).toBe(4242); // integer
    expect(r.Annual_Revenue).toBe(987654); // currency (number)
    // BMP unicode round-trips…
    expect(String(r.Description)).toContain('テスト');
    expect(String(r.Description)).toContain('ünïcödé');
    // …but Zoho stores text as 3-byte utf8: astral emoji are replaced with '?'
    // SERVICE-side (confirmed via raw-fetch probe). Connector stores verbatim.
    expect(String(r.Description)).not.toContain('🎯');
    expect(String(r.Description).length).toBeGreaterThan(1000); // long string survived
    // ownerlookup auto-populates to the API user as { id, name, ... }
    expect(typeof (r.Owner as Record<string, unknown>).id).toBe('string');

    // ── Update writable fields via changedFields ──
    const updatedName = `${NAME_PREFIX} ${suffix} (updated)`;
    await connector.updateRecords(
      spec,
      [{ id } as unknown as ConnectorFile],
      [{ Last_Name: updatedName, No_of_Employees: 99, Email_Opt_Out: false, Lead_Source: 'Online Store' }],
    );
    const afterUpdate = (await fetchById(connector, spec, id)) as Record<string, unknown>;
    expect(afterUpdate.Last_Name).toBe(updatedName);
    expect(afterUpdate.No_of_Employees).toBe(99);
    expect(afterUpdate.Email_Opt_Out).toBe(false);
    expect(afterUpdate.Lead_Source).toBe('Online Store');

    // ── Null-clear edge case ──
    await connector.updateRecords(spec, [{ id } as unknown as ConnectorFile], [{ No_of_Employees: null }]);
    expect(((await fetchById(connector, spec, id)) as Record<string, unknown>).No_of_Employees).toBeNull();

    // ── Delete (hard) ──
    await connector.deleteRecords(spec, [{ id } as unknown as ConnectorFile]);
    createdIds.splice(createdIds.indexOf(id), 1);
    expect(await fetchById(connector, spec, id)).toBeNull();
  });
});

// ===========================================================================
// Suite 3 — lookup FK both directions: Contact → Account (+ a date field)
// ===========================================================================

describeCreate('ZohoConnector — lookup FK + date round-trip', () => {
  let connector: ZohoConnector;
  let accountsSpec: BaseJsonTableSpec;
  let contactsSpec: BaseJsonTableSpec;
  const cleanup: Array<{ spec: BaseJsonTableSpec; id: string }> = [];

  beforeAll(async () => {
    connector = createConnector();
    const tables = await connector.listTables();
    const acc = tables.find((t) => t.id.wsId === 'Accounts');
    const con = tables.find((t) => t.id.wsId === 'Contacts');
    if (!acc || !con) throw new Error('Missing Accounts/Contacts');
    accountsSpec = await connector.fetchJsonTableSpec(acc.id);
    contactsSpec = await connector.fetchJsonTableSpec(con.id);
  });

  afterAll(async () => {
    for (const { spec, id } of cleanup.reverse()) {
      await connector.deleteRecords(spec, [{ id } as unknown as ConnectorFile]).catch(() => undefined);
    }
  });

  it('declares Account_Name as a foreign key to Accounts', () => {
    const fk = schemaProps(contactsSpec).Account_Name as Record<string, unknown>;
    expect(fk[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'Accounts' });
  });

  it('writes Contact.Account_Name={id} (name dropped) and reads back the {id,name} lookup + date', async () => {
    const suffix = `${Date.now()}`;

    // ── Create the target Account ──
    const [acc] = await connector.createRecords(accountsSpec, [
      { Account_Name: `${NAME_PREFIX} Acct ${suffix}` } as ConnectorFile,
    ]);
    const accountId = String((acc as Record<string, unknown>).id);
    cleanup.push({ spec: accountsSpec, id: accountId });

    // ── Create a Contact linked by id; the sanitizer must reduce {id,name}→{id} ──
    const [con] = await connector.createRecords(contactsSpec, [
      {
        Last_Name: `${NAME_PREFIX} Contact ${suffix}`,
        Account_Name: { id: accountId, name: 'ignored-on-write' },
        Date_of_Birth: '1990-07-15', // date field
      } as ConnectorFile,
    ]);
    const contactId = String((con as Record<string, unknown>).id);
    cleanup.push({ spec: contactsSpec, id: contactId });

    // ── Read: lookup comes back as { id, name } (Zoho re-hydrates name) ──
    const r = (await fetchById(connector, contactsSpec, contactId)) as Record<string, unknown>;
    const link = r.Account_Name as Record<string, unknown> | null;
    expect(link).toBeTruthy();
    expect(String((link as Record<string, unknown>).id)).toBe(accountId);
    expect(String((link as Record<string, unknown>).name)).toContain(`${NAME_PREFIX} Acct ${suffix}`);
    expect(r.Date_of_Birth).toBe('1990-07-15'); // date round-trips
  });
});

// ===========================================================================
// Suite 4 — datetime / timezone round-trip (Events.Start_DateTime)
// ===========================================================================

describeCreate('ZohoConnector — datetime/timezone round-trip', () => {
  let connector: ZohoConnector;
  let spec: BaseJsonTableSpec;
  const createdIds: string[] = [];

  beforeAll(async () => {
    connector = createConnector();
    const tables = await connector.listTables();
    const ev = tables.find((t) => t.id.wsId === 'Events');
    if (!ev) throw new Error('No Events table');
    spec = await connector.fetchJsonTableSpec(ev.id);
  });

  afterAll(async () => {
    if (createdIds.length) {
      await connector
        .deleteRecords(
          spec,
          createdIds.map((id) => ({ id }) as unknown as ConnectorFile),
        )
        .catch(() => undefined);
    }
  });

  it('preserves the exact instant when a UTC datetime is written and read back in the org offset', async () => {
    const suffix = `${Date.now()}`;
    // Write an explicit UTC instant; Zoho returns it in the org's offset.
    const startUtc = '2026-09-10T15:00:00+00:00';
    const endUtc = '2026-09-10T16:00:00+00:00';

    const [created] = await connector.createRecords(spec, [
      {
        Event_Title: `${NAME_PREFIX} Mtg ${suffix}`,
        Start_DateTime: startUtc,
        End_DateTime: endUtc,
      } as ConnectorFile,
    ]);
    const id = String((created as Record<string, unknown>).id);
    expect(id).toMatch(/^\d+$/);
    createdIds.push(id);

    const r = (await fetchById(connector, spec, id)) as Record<string, unknown>;
    // Stored verbatim as Zoho returns it (likely a non-UTC offset string), but the
    // INSTANT must be identical — tz fidelity, no silent shift.
    expect(new Date(String(r.Start_DateTime)).getTime()).toBe(new Date(startUtc).getTime());
    expect(new Date(String(r.End_DateTime)).getTime()).toBe(new Date(endUtc).getTime());
  });
});

// ===========================================================================
// Helpers
// ===========================================================================

function schemaProps(spec: BaseJsonTableSpec): Record<string, unknown> {
  return (spec.schema as unknown as { properties: Record<string, unknown> }).properties;
}

async function pullAll(
  connector: ZohoConnector,
  spec: BaseJsonTableSpec,
  options: Partial<PullRecordFilesOptions>,
): Promise<{ files: Array<Record<string, unknown>>; result: PullRecordFilesResult }> {
  const files: Array<Record<string, unknown>> = [];
  const result = await connector.pullRecordFiles(
    spec,
    async ({ files: batch }) => {
      files.push(...(batch as unknown as Array<Record<string, unknown>>));
      return Promise.resolve();
    },
    {},
    options as PullRecordFilesOptions,
  );
  return { files, result };
}

async function fetchById(
  connector: ZohoConnector,
  spec: BaseJsonTableSpec,
  id: string,
): Promise<Record<string, unknown> | null> {
  const got: ConnectorFile[] = [];
  await connector.pullRecordFilesByIds(spec, [id], async ({ files }) => {
    got.push(...files);
    return Promise.resolve();
  });
  return (got[0] as Record<string, unknown> | undefined) ?? null;
}
