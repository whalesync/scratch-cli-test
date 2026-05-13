import { TSchema } from '@sinclair/typebox';
import { BaseJsonTableSpec, ConnectorFile } from '../../../types';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Airtable'),
}));

const mockUpdateRecords = jest.fn();
const mockListBases = jest.fn();
const mockCreateRecords = jest.fn();
const mockDeleteRecords = jest.fn();

jest.mock('../airtable-api-client', () => ({
  AirtableApiClient: jest.fn().mockImplementation(() => ({
    listBases: mockListBases,
    createRecords: mockCreateRecords,
    updateRecords: mockUpdateRecords,
    deleteRecords: mockDeleteRecords,
  })),
}));

import { AirtableConnector } from '../airtable-connector';

// Schema that marks `Date/heure de création` as read-only — same shape used in prod
// (per DEV-10125 repro). `isReadonlyField` walks /properties/fields/properties/<name>/x-scratch-readonly.
function buildTableSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'table', remoteId: ['appXYZ', 'tblABC'] },
    slug: 'table',
    name: 'table',
    idColumnRemoteId: 'id',
    schema: {
      properties: {
        fields: {
          properties: {
            'Date/heure de création': { 'x-scratch-readonly': true },
          },
        },
      },
    } as unknown as TSchema,
  };
}

describe('AirtableConnector.updateRecords', () => {
  let connector: AirtableConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateRecords.mockResolvedValue([]);
    connector = new AirtableConnector('test-api-key');
  });

  // DEV-10125: the original bug. The full file had ~30 fields (incl. a computed
  // read-only field). The user edited one field. The PATCH must contain *only*
  // the changed field — not the other 29, and especially not the computed one.
  it('sends only the changed field to Airtable when changedFields is sparse', async () => {
    const fullFields = {
      Name: 'Acme Corp',
      Email: 'contact@acme.com',
      Phone: '+1-555-0100',
      Notes: 'Existing notes',
      Status: 'Active',
      'Date/heure de création': '2026-01-01T00:00:00.000Z', // computed/read-only
    };
    const files: ConnectorFile[] = [
      {
        id: 'recABC',
        fields: fullFields,
      },
    ];
    // Only Notes changed.
    const changedFields: Record<string, unknown>[] = [{ fields: { Notes: 'New notes' } }];

    await connector.updateRecords(buildTableSpec(), files, changedFields);

    expect(mockUpdateRecords).toHaveBeenCalledTimes(1);
    const [baseId, tableId, records] = mockUpdateRecords.mock.calls[0] as [
      string,
      string,
      { id: string; fields: Record<string, unknown> }[],
    ];
    expect(baseId).toBe('appXYZ');
    expect(tableId).toBe('tblABC');
    expect(records).toHaveLength(1);
    expect(records[0].id).toBe('recABC');
    expect(records[0].fields).toEqual({ Notes: 'New notes' });
  });

  it('strips read-only fields even when present in changedFields', async () => {
    const files: ConnectorFile[] = [
      {
        id: 'recABC',
        fields: { Name: 'A', 'Date/heure de création': '2026-01-01T00:00:00.000Z' },
      },
    ];
    // Both Name and the read-only field appear as "changed" (e.g. stale pull recompute).
    const changedFields: Record<string, unknown>[] = [
      { fields: { Name: 'B', 'Date/heure de création': '2026-02-02T00:00:00.000Z' } },
    ];

    await connector.updateRecords(buildTableSpec(), files, changedFields);

    const [, , records] = mockUpdateRecords.mock.calls[0] as [
      string,
      string,
      { id: string; fields: Record<string, unknown> }[],
    ];
    // The computed field must not leak through — that's what made Airtable return 422.
    expect(records[0].fields).toEqual({ Name: 'B' });
  });
});
