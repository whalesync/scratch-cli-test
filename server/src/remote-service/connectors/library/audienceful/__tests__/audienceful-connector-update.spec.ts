import { BaseJsonTableSpec, ConnectorFile, EntityId } from '../../../types';

// Break the circular import chain through ../../connector -> display-names.
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Audienceful'),
}));

const mockUpdatePerson = jest.fn();

jest.mock('../audienceful-api-client', () => ({
  AudiencefulApiClient: jest.fn().mockImplementation(() => ({
    updatePerson: mockUpdatePerson,
  })),
  AudiencefulError: class AudiencefulError extends Error {
    statusCode?: number;
    constructor(message: string, statusCode?: number) {
      super(message);
      this.name = 'AudiencefulError';
      this.statusCode = statusCode;
    }
  },
}));

import { AudiencefulConnector } from '../audienceful-connector';

function peopleTableSpec(): BaseJsonTableSpec {
  const id: EntityId = { wsId: 'people', remoteId: ['people'] };
  return { id, slug: 'people', name: 'People', idPath: 'uid', schema: {} } as unknown as BaseJsonTableSpec;
}

describe('AudiencefulConnector.updateRecords', () => {
  let connector: AudiencefulConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdatePerson.mockResolvedValue({});
    connector = new AudiencefulConnector('test-key');
  });

  it('sends the changed writable field plus the email lookup key', async () => {
    const files: ConnectorFile[] = [{ uid: 'p1', email: 'a@example.com' }];
    const changedFields: Record<string, unknown>[] = [{ notes: 'hello' }];

    await connector.updateRecords(peopleTableSpec(), files, changedFields);

    expect(mockUpdatePerson).toHaveBeenCalledWith(expect.objectContaining({ email: 'a@example.com', notes: 'hello' }));
  });

  // DEV-10597: an edit to an API-computed field (uid/status/created_at/updated_at)
  // is a genuine read-only edit — surface it instead of silently dropping it.
  it('throws when a changed field is read-only, and does not call the API', async () => {
    const files: ConnectorFile[] = [{ uid: 'p1', email: 'a@example.com', status: 'active' }];
    const changedFields: Record<string, unknown>[] = [{ status: 'unsubscribed' }];

    await expect(connector.updateRecords(peopleTableSpec(), files, changedFields)).rejects.toThrow(
      /"status" is read-only/,
    );
    expect(mockUpdatePerson).not.toHaveBeenCalled();
  });
});
