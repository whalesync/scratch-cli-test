const mockPost = jest.fn();

jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(() => ({ post: mockPost })),
}));

import type { EntityType } from '../graphql';
import { LinearApiClient } from '../linear-api-client';
import { buildLinearUpdatedAtFilter } from '../linear-incremental';

/** Resolve an empty connection so paginatedList stops after one request. */
function emptyConnection(rootField: string) {
  return {
    data: { data: { [rootField]: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } },
  };
}

/** Consume an async generator fully (the mocked connection yields nothing). */
async function drain(gen: AsyncIterable<unknown>): Promise<number> {
  let count = 0;
  for await (const page of gen) {
    if (page) count += 1;
  }
  return count;
}

function lastPostBody(): { query: string; variables: Record<string, unknown> } {
  const [, body] = mockPost.mock.calls[mockPost.mock.calls.length - 1] as [
    string,
    { query: string; variables: Record<string, unknown> },
  ];
  return body;
}

describe('LinearApiClient.listEntities query builder', () => {
  let client: LinearApiClient;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new LinearApiClient({ accessToken: 'fake' });
  });

  it('full scan: emits the unchanged query with no $filter and no filter variable', async () => {
    mockPost.mockResolvedValue(emptyConnection('issues'));

    await drain(client.listEntities('issues', 50));

    const { query, variables } = lastPostBody();
    expect(query).toContain('query ListIssues($first: Int!, $after: String)');
    expect(query).toContain('issues(first: $first, after: $after)');
    expect(query).not.toContain('$filter');
    expect(variables).toEqual({ first: 50, after: null });
  });

  // entityType → root connection field + Linear filter input type name
  const cases: Array<[EntityType, string, string]> = [
    ['issues', 'issues', 'IssueFilter'],
    ['projects', 'projects', 'ProjectFilter'],
    ['teams', 'teams', 'TeamFilter'],
    ['users', 'users', 'UserFilter'],
    ['labels', 'issueLabels', 'IssueLabelFilter'],
    ['cycles', 'cycles', 'CycleFilter'],
  ];

  it.each(cases)(
    'incremental %s: declares $filter: %s#%s and passes the filter variable',
    async (entityType, rootField, filterType) => {
      mockPost.mockResolvedValue(emptyConnection(rootField));
      const since = new Date('2026-05-14T12:00:00.000Z');
      const filter = buildLinearUpdatedAtFilter(since);

      await drain(client.listEntities(entityType, 25, undefined, filter));

      const { query, variables } = lastPostBody();
      expect(query).toContain(`$first: Int!, $after: String, $filter: ${filterType}`);
      expect(query).toContain(`${rootField}(first: $first, after: $after, filter: $filter)`);
      expect(variables).toEqual({ first: 25, after: null, filter });
      expect(filter).toEqual({ updatedAt: { gt: '2026-05-14T11:59:00.000Z' } });
    },
  );
});
