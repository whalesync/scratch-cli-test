import { TSchema } from '@sinclair/typebox';
import { BaseJsonTableSpec, ConnectorFile, dotPath } from '../../../types';

// Break the connector-registry circular import chain.
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Moco CRM'),
}));

const mockUpdateEntity = jest.fn();

jest.mock('../moco-api-client', () => {
  class MocoError extends Error {
    constructor(
      message: string,
      public statusCode?: number,
      public code?: string,
      public responseData?: unknown,
    ) {
      super(message);
      this.name = 'MocoError';
    }
  }
  return {
    MocoError,
    MocoApiClient: jest.fn().mockImplementation(() => ({
      updateEntity: mockUpdateEntity,
    })),
  };
});

import { MocoConnector } from '../moco-connector';

function companiesTableSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'companies', remoteId: ['companies'] },
    slug: 'companies',
    name: 'Companies',
    idPath: dotPath('id'),
    schema: {} as unknown as TSchema,
  };
}

describe('MocoConnector.updateRecords', () => {
  let connector: MocoConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateEntity.mockResolvedValue({});
    connector = new MocoConnector({ domain: 'acme', apiKey: 'fake' });
  });

  it('sends only the changed writable (allow-listed) fields', async () => {
    const files: ConnectorFile[] = [{ id: 1, name: 'Old' }];
    const changedFields: Record<string, unknown>[] = [{ name: 'New' }];

    await connector.updateRecords(companiesTableSpec(), files, changedFields);

    expect(mockUpdateEntity).toHaveBeenCalledWith('companies', 1, { name: 'New' });
  });

  // DEV-10597: a non-allow-listed field in the sparse changedFields is a genuine
  // read-only edit. Surface it instead of silently dropping it to a no-op PUT.
  it('throws when a changed field is not writable, and does not call the API', async () => {
    const files: ConnectorFile[] = [{ id: 1, created_at: '2026-01-01' }];
    const changedFields: Record<string, unknown>[] = [{ created_at: '2026-02-02' }];

    await expect(connector.updateRecords(companiesTableSpec(), files, changedFields)).rejects.toThrow(
      /"created_at" is read-only/,
    );
    expect(mockUpdateEntity).not.toHaveBeenCalled();
  });

  it('throws when a non-writable field is changed alongside a writable one', async () => {
    const files: ConnectorFile[] = [{ id: 1, name: 'Old', created_at: 'x' }];
    const changedFields: Record<string, unknown>[] = [{ name: 'New', created_at: 'y' }];

    await expect(connector.updateRecords(companiesTableSpec(), files, changedFields)).rejects.toThrow(
      /read-only and cannot be published/,
    );
    expect(mockUpdateEntity).not.toHaveBeenCalled();
  });
});
