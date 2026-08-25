import { BaseJsonTableSpec, ConnectorFile, EntityId } from '../../../types';
import { LinearConnector } from '../linear-connector';

// Break the circular import chain through ../../connector -> display-names.
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Linear'),
}));

const mockUpdateIssue = jest.fn();
const mockCreateIssue = jest.fn();

jest.mock('../linear-api-client', () => ({
  LinearApiClient: jest.fn().mockImplementation(() => ({
    updateIssue: mockUpdateIssue,
    createIssue: mockCreateIssue,
  })),
  LinearError: class LinearError extends Error {
    statusCode?: number;
    code?: string;
    constructor(message: string, statusCode?: number, code?: string) {
      super(message);
      this.name = 'LinearError';
      this.statusCode = statusCode;
      this.code = code;
    }
  },
}));

function issuesTableSpec(): BaseJsonTableSpec {
  const id: EntityId = { wsId: 'issues', remoteId: ['issues'] };
  return { id, slug: 'issues', name: 'Issues', idPath: 'id', schema: {} } as unknown as BaseJsonTableSpec;
}

describe('LinearConnector.updateRecords', () => {
  let connector: LinearConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    mockUpdateIssue.mockResolvedValue({});
    connector = new LinearConnector({ accessToken: 'lin_test' });
  });

  it('sends only the changed writable fields when changedFields is sparse', async () => {
    const files: ConnectorFile[] = [{ id: 'issue_1', title: 'Old' }];
    const changedFields: Record<string, unknown>[] = [{ title: 'New' }];

    await connector.updateRecords(issuesTableSpec(), files, changedFields);

    expect(mockUpdateIssue).toHaveBeenCalledWith('issue_1', { title: 'New' });
  });

  // DEV-10597 / DEV-10607: `createdAt` is a write-once field (settable on create,
  // rejected on update), not truly read-only. Surface it — with wording that says
  // so — instead of stripping it to an empty/partial mutation and reporting success.
  it('throws with set-on-create-only wording when a changed field is write-once, and does not call the API', async () => {
    const files: ConnectorFile[] = [{ id: 'issue_1', createdAt: '2026-01-01T00:00:00Z' }];
    const changedFields: Record<string, unknown>[] = [{ createdAt: '2026-02-02T00:00:00Z' }];

    await expect(connector.updateRecords(issuesTableSpec(), files, changedFields)).rejects.toThrow(
      /"createdAt" cannot be edited after the record is created/,
    );
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });

  it('throws when a read-only field is changed alongside a writable one', async () => {
    const files: ConnectorFile[] = [{ id: 'issue_1', title: 'Old', archivedAt: null }];
    const changedFields: Record<string, unknown>[] = [{ title: 'New', archivedAt: '2026-02-02T00:00:00Z' }];

    await expect(connector.updateRecords(issuesTableSpec(), files, changedFields)).rejects.toThrow(
      /read-only and cannot be published/,
    );
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });

  // DEV-10607: a truly read-only field and a write-once field changed in the same
  // publish surface as one message with a distinct clause per category.
  it('throws with both read-only and set-on-create-only clauses when both kinds of field change', async () => {
    const files: ConnectorFile[] = [{ id: 'issue_1', archivedAt: null, createdAt: '2026-01-01T00:00:00Z' }];
    const changedFields: Record<string, unknown>[] = [
      { archivedAt: '2026-02-02T00:00:00Z', createdAt: '2026-02-02T00:00:00Z' },
    ];

    const updatePromise = connector.updateRecords(issuesTableSpec(), files, changedFields);
    await expect(updatePromise).rejects.toThrow(/"archivedAt" is read-only and cannot be published/);
    await expect(updatePromise).rejects.toThrow(/"createdAt" cannot be edited after the record is created/);
    expect(mockUpdateIssue).not.toHaveBeenCalled();
  });
});
