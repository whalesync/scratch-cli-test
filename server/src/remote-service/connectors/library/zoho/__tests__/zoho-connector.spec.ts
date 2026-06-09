import { ZohoApiClient } from '../zoho-api-client';
import { ZohoConnector } from '../zoho-connector';
import { ZohoModuleMetadata } from '../zoho-types';

function makeConnector(): ZohoConnector {
  return new ZohoConnector({ clientId: 'c', clientSecret: 's', refreshToken: 'r', dataCenter: 'US' });
}

const MODULES: ZohoModuleMetadata[] = [
  { api_name: 'Leads', plural_label: 'Leads', api_supported: true, creatable: true, editable: true, deletable: true },
  // Read-only system module (creatable=false) — listed but create-disabled.
  {
    api_name: 'DealHistory',
    plural_label: 'Deal History',
    generated_type: 'field_tracker',
    api_supported: true,
    creatable: false,
    editable: false,
    deletable: false,
  },
  // Not reachable through the records API — excluded.
  { api_name: 'Home', plural_label: 'Home', api_supported: false },
  // Subform sub-module — excluded.
  { api_name: 'Quoted_Items', plural_label: 'Quoted Items', api_supported: true, subform: true },
];

describe('ZohoConnector.listTables — eligibility policy', () => {
  afterEach(() => jest.restoreAllMocks());

  it('lists only api_supported, non-subform modules and flags non-writable ones', async () => {
    jest.spyOn(ZohoApiClient.prototype, 'listModules').mockResolvedValue(MODULES);
    const tables = await makeConnector().listTables();

    const byId = new Map(tables.map((t) => [t.id.wsId, t]));
    // The two eligible modules plus the always-appended read-only `users` table.
    expect([...byId.keys()].sort()).toEqual(['DealHistory', 'Leads', 'users']);

    const leads = byId.get('Leads');
    expect(leads?.disabledCreates).toBeUndefined();
    expect(leads?.parentPath).toBe('Sales');

    // Users is a synthetic, read-only reference table (FK target of *.Owner).
    const users = byId.get('users');
    expect(users?.id.remoteId).toEqual(['users']);
    expect(users?.disabledCreates).toBe(true);
    expect(users?.disabledUpdates).toBe(true);
    expect(users?.disabledDeletes).toBe(true);

    const dealHistory = byId.get('DealHistory');
    expect(dealHistory?.disabledCreates).toBe(true);
    expect(dealHistory?.disabledUpdates).toBe(true);
    expect(dealHistory?.disabledDeletes).toBe(true);
    expect(dealHistory?.disabledReason).toBeTruthy();
  });

  it('fails loud when discovery errors — no static fallback list', async () => {
    jest.spyOn(ZohoApiClient.prototype, 'listModules').mockRejectedValue(new Error('Zoho metadata down'));
    await expect(makeConnector().listTables()).rejects.toThrow('Zoho metadata down');
  });
});
