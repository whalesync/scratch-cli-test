import { TSchema } from '@sinclair/typebox';
import { BaseJsonTableSpec, ConnectorFile, dotPath } from '../../../types';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Memberstack'),
}));

const mockUpdateMember = jest.fn();
const mockValidateCredentials = jest.fn();

jest.mock('../memberstack-api-client', () => ({
  MemberstackApiClient: jest.fn().mockImplementation(() => ({
    updateMember: mockUpdateMember,
    validateCredentials: mockValidateCredentials,
  })),
  MemberstackError: class extends Error {},
}));

import { MemberstackConnector } from '../memberstack-connector';

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
