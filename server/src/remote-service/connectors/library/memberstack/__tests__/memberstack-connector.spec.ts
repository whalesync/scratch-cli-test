import { TSchema } from '@sinclair/typebox';
import { BaseJsonTableSpec, ConnectorFile, dotPath } from '../../../types';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Memberstack'),
}));

const mockUpdateMember = jest.fn();
const mockValidateCredentials = jest.fn();
const mockFetchSampleCustomFieldKeys = jest.fn();

jest.mock('../memberstack-api-client', () => ({
  MemberstackApiClient: jest.fn().mockImplementation(() => ({
    updateMember: mockUpdateMember,
    validateCredentials: mockValidateCredentials,
    fetchSampleCustomFieldKeys: mockFetchSampleCustomFieldKeys,
  })),
  MemberstackError: class extends Error {
    statusCode?: number;
    constructor(message: string, statusCode?: number) {
      super(message);
      this.statusCode = statusCode;
    }
  },
}));

import { MemberstackConnector } from '../memberstack-connector';

type InnerObject = { type?: string; properties?: Record<string, { type?: string }>; additionalProperties?: unknown };
type SchemaObject = { type?: string; properties?: Record<string, InnerObject>; additionalProperties?: unknown };

function customFieldsProperties(schema: unknown): Record<string, { type?: string }> {
  const root = schema as SchemaObject;
  return root.properties?.customFields?.properties ?? {};
}

function buildTableSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'members', remoteId: ['members'] },
    slug: 'members',
    name: 'members',
    idPath: dotPath('id'),
    schema: {} as unknown as TSchema,
  };
}

describe('MemberstackConnector.updateRecords', () => {
  let connector: MemberstackConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateMember.mockResolvedValue({ id: 'mem_1' });
    connector = new MemberstackConnector('test-api-key');
  });

  // Memberstack stores email under `auth.email`, not as a top-level field.
  // When the user edits the email, the sparse changedFields is { auth: { email: ... } }
  // (pickByShape recurses on plain objects). The connector must surface that
  // as `email: ...` on the API call.
  it('surfaces email from nested auth.email when changed', async () => {
    const files: ConnectorFile[] = [
      {
        id: 'mem_1',
        auth: { email: 'old@example.com' },
        customFields: { plan: 'pro' },
      },
    ];
    const changedFields: Record<string, unknown>[] = [{ auth: { email: 'new@example.com' } }];

    await connector.updateRecords(buildTableSpec(), files, changedFields);

    const [memberId, payload] = mockUpdateMember.mock.calls[0] as [string, Record<string, unknown>];
    expect(memberId).toBe('mem_1');
    expect(payload.email).toBe('new@example.com');
    expect(payload.customFields).toBeUndefined();
    expect(payload.metaData).toBeUndefined();
    expect(payload.json).toBeUndefined();
    expect(payload.loginRedirect).toBeUndefined();
  });

  // When auth is unchanged, email must not be sent at all.
  it('omits email when auth is not in changedFields', async () => {
    const files: ConnectorFile[] = [
      {
        id: 'mem_1',
        auth: { email: 'unchanged@example.com' },
        customFields: { plan: 'pro' },
      },
    ];
    const changedFields: Record<string, unknown>[] = [{ customFields: { plan: 'free' } }];

    await connector.updateRecords(buildTableSpec(), files, changedFields);

    const [, payload] = mockUpdateMember.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.email).toBeUndefined();
    expect(payload.customFields).toEqual({ plan: 'free' });
  });
});

describe('MemberstackConnector.fetchJsonTableSpec — custom-field expansion', () => {
  let connector: MemberstackConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new MemberstackConnector('test-api-key');
  });

  it('samples custom-field keys and expands them into individual string columns', async () => {
    mockFetchSampleCustomFieldKeys.mockResolvedValue(['company', 'first-name']);

    const spec = await connector.fetchJsonTableSpec({ wsId: 'members', remoteId: ['members'] });

    expect(mockFetchSampleCustomFieldKeys).toHaveBeenCalledTimes(1);
    const props = customFieldsProperties(spec.schema);
    expect(Object.keys(props)).toEqual(['company', 'first-name']);
    expect(props['company'].type).toBe('string');
    expect(props['first-name'].type).toBe('string');
  });

  it('falls back to an open customFields record when sampling fails (does not throw)', async () => {
    mockFetchSampleCustomFieldKeys.mockRejectedValue(new Error('rate limited'));

    const spec = await connector.fetchJsonTableSpec({ wsId: 'members', remoteId: ['members'] });

    // No per-key columns, but schema still builds — graceful degradation. The fallback
    // is a single open object (no `properties`) so customFields renders as one blob.
    expect(customFieldsProperties(spec.schema)).toEqual({});
    const customFields = (spec.schema as SchemaObject).properties?.customFields;
    expect(customFields?.type).toBe('object');
    expect(customFields?.properties).toBeUndefined();
  });

  it('does not expand custom fields when a sampled key contains a dot', async () => {
    mockFetchSampleCustomFieldKeys.mockResolvedValue(['first-name', 'plan.tier']);

    const spec = await connector.fetchJsonTableSpec({ wsId: 'members', remoteId: ['members'] });

    // A dotted key would collide with the dot-path column engine, so the whole object
    // stays a single JSON field rather than producing a broken column.
    expect(customFieldsProperties(spec.schema)).toEqual({});
    expect((spec.schema as SchemaObject).properties?.customFields?.properties).toBeUndefined();
  });

  it('rejects unknown tables without sampling', async () => {
    await expect(connector.fetchJsonTableSpec({ wsId: 'nope', remoteId: ['nope'] })).rejects.toThrow();
    expect(mockFetchSampleCustomFieldKeys).not.toHaveBeenCalled();
  });
});
