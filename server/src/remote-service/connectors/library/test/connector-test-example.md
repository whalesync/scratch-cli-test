# Connector Test Pattern Guide

This guide shows how to write consistent, minimal tests for connectors.

## Quick Start Pattern

All connector tests should follow this structure:

```typescript
import { Service } from '@spinner/shared-types';
import { Type } from '@sinclair/typebox';
import { BaseJsonTableSpec, ConnectorFile } from '../../types';

// 1. DEFINE MOCK CLIENT TYPE
type MockYourClient = {
  // Only mock the methods your connector actually calls
  getData: jest.Mock;
  postData: jest.Mock;
  deleteData: jest.Mock;
};

// 2. CREATE MOCK CLIENT FACTORY
const createMockClient = (): MockYourClient => ({
  getData: jest.fn(),
  postData: jest.fn(),
  deleteData: jest.fn(),
});

// 3. SET UP MODULE-LEVEL MOCKING (before imports!)
const mockClientWrapper = {
  client: createMockClient(),
};

jest.mock('your-api-library', () => ({
  YourApiClient: jest.fn(() => mockClientWrapper.client),
}));

// 4. IMPORT YOUR CONNECTOR AFTER MOCKS
import { YourConnector } from './your-connector';

// 5. WRITE TESTS
describe('YourConnector', () => {
  let connector: YourConnector;
  let mockClient: MockYourClient;

  // Minimal BaseJsonTableSpec for testing
  const mockTableSpec: BaseJsonTableSpec = {
    id: { wsId: 'table1', remoteId: ['table123'] },
    slug: 'test-table',
    name: 'Test Table',
    idColumnRemoteId: 'id',
    schema: Type.Object({
      id: Type.String(),
      name: Type.String(),
    }),
  };

  beforeEach(() => {
    // Create fresh mock client for each test
    mockClientWrapper.client = createMockClient();
    mockClient = mockClientWrapper.client;
    connector = new YourConnector('test-credentials');
  });

  describe('pullRecordFiles', () => {
    it('should pull record files and transform to JSON', async () => {
      // Mock API response with MINIMAL data (2-3 records max)
      mockClient.getData.mockResolvedValue({
        items: [
          { id: 'item1', name: 'Test 1' },
          { id: 'item2', name: 'Test 2' },
        ],
      });

      const callback = jest.fn().mockResolvedValue(undefined);

      await connector.pullRecordFiles(mockTableSpec, callback, {});

      expect(callback).toHaveBeenCalledTimes(1);
      const { files } = callback.mock.calls[0][0] as { files: ConnectorFile[] };
      expect(files).toHaveLength(2);
      expect(files[0]).toMatchObject({ id: 'item1', name: 'Test 1' });
    });

    it('should handle pagination correctly', async () => {
      // Set up multi-page response
      mockClient.getData
        .mockResolvedValueOnce({
          items: [
            { id: 'item1', name: 'Item 1' },
            { id: 'item2', name: 'Item 2' },
          ],
          hasMore: true,
          nextCursor: 'cursor1',
        })
        .mockResolvedValueOnce({
          items: [{ id: 'item3', name: 'Item 3' }],
          hasMore: false,
          nextCursor: null,
        });

      const callback = jest.fn().mockResolvedValue(undefined);

      await connector.pullRecordFiles(mockTableSpec, callback, {});

      expect(mockClient.getData).toHaveBeenCalledTimes(2);
      expect(callback).toHaveBeenCalledTimes(2);

      const firstBatch = (callback.mock.calls[0][0] as { files: ConnectorFile[] }).files;
      const secondBatch = (callback.mock.calls[1][0] as { files: ConnectorFile[] }).files;
      expect(firstBatch).toHaveLength(2);
      expect(secondBatch).toHaveLength(1);
    });

    it('should pass progress through callback for resumability', async () => {
      mockClient.getData.mockResolvedValue({
        items: [{ id: 'item1', name: 'Test 1' }],
        hasMore: false,
      });

      const callback = jest.fn().mockResolvedValue(undefined);

      await connector.pullRecordFiles(mockTableSpec, callback, {});

      // Verify callback receives connectorProgress for resume support
      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          files: expect.any(Array),
          // connectorProgress is optional — connectors that support resume will include it
        }),
      );
    });
  });

  describe('displayName', () => {
    it('should return YourService as display name', () => {
      // displayName is a static property on the class, not an instance method
      expect(YourConnector.displayName).toBe('YourService');
    });
  });

  describe('service', () => {
    it('should have YOUR_SERVICE service type', () => {
      expect(connector.service).toBe(Service.YOUR_SERVICE);
    });
  });

  describe('getBatchSize', () => {
    it('should return batch sizes for each operation type', () => {
      expect(connector.getBatchSize('create')).toBeGreaterThan(0);
      expect(connector.getBatchSize('update')).toBeGreaterThan(0);
      expect(connector.getBatchSize('delete')).toBeGreaterThan(0);
    });
  });

  describe('testConnection', () => {
    it('should resolve when connection is valid', async () => {
      mockClient.getData.mockResolvedValue({ ok: true });
      await expect(connector.testConnection()).resolves.toBeUndefined();
    });

    it('should throw when connection is invalid', async () => {
      mockClient.getData.mockRejectedValue(new Error('Unauthorized'));
      await expect(connector.testConnection()).rejects.toThrow();
    });
  });

  describe('listTables', () => {
    it('should return available tables', async () => {
      mockClient.getData.mockResolvedValue({
        tables: [
          { id: 'tbl1', name: 'Products' },
          { id: 'tbl2', name: 'Orders' },
        ],
      });

      const tables = await connector.listTables();

      expect(tables).toHaveLength(2);
      expect(tables[0]).toMatchObject({
        id: expect.objectContaining({ wsId: expect.any(String), remoteId: expect.any(Array) }),
        displayName: expect.any(String),
      });
    });
  });

  describe('extractConnectorErrorDetails', () => {
    it('should translate known API errors', () => {
      const error = new Error('Rate limit exceeded');
      const details = connector.extractConnectorErrorDetails(error);
      expect(details.userFriendlyMessage).toBeDefined();
      expect(typeof details.userFriendlyMessage).toBe('string');
    });

    it('should handle unknown errors gracefully', () => {
      const details = connector.extractConnectorErrorDetails('unexpected string error');
      expect(details.userFriendlyMessage).toBeDefined();
    });
  });

  describe('createRecords', () => {
    it('should create records and return files with remote IDs', async () => {
      const newFiles: ConnectorFile[] = [{ name: 'New Item 1' }, { name: 'New Item 2' }];

      mockClient.postData.mockResolvedValue({
        items: [
          { id: 'new1', name: 'New Item 1' },
          { id: 'new2', name: 'New Item 2' },
        ],
      });

      const result = await connector.createRecords(mockTableSpec, {}, newFiles);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: 'new1' });
    });
  });

  describe('updateRecords', () => {
    it('should update records', async () => {
      const files: ConnectorFile[] = [{ id: 'item1', name: 'Updated Name' }];

      mockClient.postData.mockResolvedValue({});

      await expect(connector.updateRecords(mockTableSpec, {}, files)).resolves.toBeUndefined();
    });
  });

  describe('deleteRecords', () => {
    it('should delete records', async () => {
      const files: ConnectorFile[] = [{ id: 'item1', name: 'To Delete' }];

      mockClient.deleteData.mockResolvedValue({});

      await expect(connector.deleteRecords(mockTableSpec, files)).resolves.toBeUndefined();
    });
  });
});
```

## Why Use a Wrapper Object?

The `mockClientWrapper` pattern ensures the mock reference stays consistent:

```typescript
// This wrapper allows us to replace the client in each test
const mockClientWrapper = {
  client: createMockClient(),
};

// Jest captures this reference once
jest.mock('your-api-library', () => ({
  YourApiClient: jest.fn(() => mockClientWrapper.client),
}));

// In each test, we replace the client
beforeEach(() => {
  mockClientWrapper.client = createMockClient(); // Updates the reference Jest uses
  mockClient = mockClientWrapper.client;
});
```

Without the wrapper, reassigning the variable wouldn't work:

```typescript
// BAD - This doesn't work - Jest captured the old reference
let mockClient = createMockClient();
jest.mock('your-api-library', () => ({
  YourApiClient: jest.fn(() => mockClient), // Captured once!
}));

beforeEach(() => {
  mockClient = createMockClient(); // This doesn't update the mock
});
```

## Common Pagination Patterns

### Cursor-based (Notion)

The Notion connector uses cursor-based pagination with progress tracking for resumability:

```typescript
it('should handle cursor-based pagination', async () => {
  mockClient.databases.query
    .mockResolvedValueOnce({
      results: [{ id: 'page1', properties: { name: { title: [{ plain_text: 'Page 1' }] } } }],
      has_more: true,
      next_cursor: 'cursor1',
    })
    .mockResolvedValueOnce({
      results: [{ id: 'page2', properties: { name: { title: [{ plain_text: 'Page 2' }] } } }],
      has_more: false,
      next_cursor: null,
    });

  const callback = jest.fn().mockResolvedValue(undefined);
  await connector.pullRecordFiles(mockTableSpec, callback, {});

  expect(mockClient.databases.query).toHaveBeenCalledTimes(2);
  expect(mockClient.databases.query).toHaveBeenNthCalledWith(2, expect.objectContaining({ start_cursor: 'cursor1' }));

  // Verify progress is passed for resume support
  expect(callback).toHaveBeenCalledWith(
    expect.objectContaining({
      connectorProgress: expect.objectContaining({ nextCursor: 'cursor1' }),
    }),
  );
});
```

### Offset-based (Webflow)

```typescript
it('should handle offset-based pagination', async () => {
  mockClient.listCollectionItems
    .mockResolvedValueOnce({
      items: [{ id: 'item1', fieldData: { name: 'Item 1' } }],
      pagination: { total: 2, offset: 0, limit: 1 },
    })
    .mockResolvedValueOnce({
      items: [{ id: 'item2', fieldData: { name: 'Item 2' } }],
      pagination: { total: 2, offset: 1, limit: 1 },
    });

  const callback = jest.fn().mockResolvedValue(undefined);
  await connector.pullRecordFiles(mockTableSpec, callback, {});

  expect(mockClient.listCollectionItems).toHaveBeenCalledTimes(2);
  expect(callback).toHaveBeenCalledTimes(2);
});
```

### Async Iterator (Airtable)

The Airtable connector delegates pagination to its API client using async iterators:

```typescript
it('should handle async iterator pagination', async () => {
  // Mock the client to return an async iterable
  const batches = [[{ id: 'rec1', fields: { Name: 'Record 1' } }], [{ id: 'rec2', fields: { Name: 'Record 2' } }]];

  mockClient.listRecords.mockReturnValue(
    {
      [Symbol.asyncIterator]: async function* () {
        for (const batch of batches) {
          yield batch;
        }
      },
    }(),
  );

  const callback = jest.fn().mockResolvedValue(undefined);
  await connector.pullRecordFiles(mockTableSpec, callback, {});

  expect(callback).toHaveBeenCalledTimes(2);
});
```

## Building a BaseJsonTableSpec for Tests

The `BaseJsonTableSpec` uses JSON Schema (via `@sinclair/typebox`) instead of column-based specs:

```typescript
import { Type } from '@sinclair/typebox';
import { BaseJsonTableSpec } from '../../types';

// Minimal spec for most tests
const mockTableSpec: BaseJsonTableSpec = {
  id: { wsId: 'products', remoteId: ['tbl123'] },
  slug: 'products',
  name: 'Products',
  idColumnRemoteId: 'id',
  schema: Type.Object({
    id: Type.String(),
    name: Type.String(),
    price: Type.Optional(Type.Number()),
  }),
};

// Spec with optional metadata fields
const specWithMetadata: BaseJsonTableSpec = {
  id: { wsId: 'posts', remoteId: ['col456', 'posts'] },
  slug: 'blog-posts',
  name: 'Blog Posts',
  idColumnRemoteId: 'id',
  titleColumnRemoteId: ['title'],
  mainContentColumnRemoteId: ['body'],
  slugColumnRemoteId: 'fieldData.slug',
  schema: Type.Object({
    id: Type.String(),
    title: Type.String(),
    body: Type.String(),
  }),
};
```

## Key Principles

### 1. Mock the API Client, Not the Internals

- Mock the SDK/API client that your connector uses
- Don't test the HTTP client itself — assume it works
- Only mock methods your connector actually calls

```typescript
// GOOD: Mock the connector's api-client
jest.mock('../webflow-api-client', () => ({
  WebflowApiClient: jest.fn(() => mockClientWrapper.client),
}));

// BAD: Mock HTTP internals
jest.mock('https');
```

### 2. Use Minimal Data

- **1-2 field types max** in `BaseJsonTableSpec` schemas
- **2-3 records max** in basic test data
- Use small batches for pagination tests (2 items per page is fine for testing)
- Avoid complex nested structures

```typescript
// GOOD: Minimal ConnectorFile data
const mockFiles: ConnectorFile[] = [
  { id: 'item1', name: 'Test 1' },
  { id: 'item2', name: 'Test 2' },
];

// BAD: Too much data
const mockFiles = Array.from({ length: 1000 }, (_, i) => ({
  id: `item${i}`,
  field1: '...',
  field2: '...',
  // ... 20 more fields
}));
```

### 3. Test Core Logic, Not Everything

Focus on:

- Download mechanism (`pullRecordFiles`)
- Pagination logic (cursor, offset, async iterator)
- Data transformation (API response → `ConnectorFile`)
- CRUD operations (`createRecords`, `updateRecords`, `deleteRecords`)
- Error translation (`extractConnectorErrorDetails`)
- Connection validation (`testConnection`)
- Connector-specific features (rich text, metadata, schema handling)

Don't test:

- The API client/SDK itself
- Network layer
- Every possible field type combination

### 4. Required Test Coverage

Every connector test file MUST include:

1. `pullRecordFiles` — basic download test
2. `pullRecordFiles` — pagination test
3. `displayName` static property test
4. `service` property test
5. `getBatchSize(operation)` test for all three operation types
6. `testConnection` — success and failure
7. `extractConnectorErrorDetails` — known and unknown errors

Additional tests based on connector features:

- `getNewFile` template generation
- `validateFiles` pre-publish validation
- Rich text conversion (HTML ↔ Markdown)
- Special field types or schema handling
- Progress/resume functionality via `connectorProgress`

## Troubleshooting

### "Mock was not called" or tests timing out

Make sure your mock is set up **before** importing the connector:

```typescript
// GOOD — mock before import
jest.mock('your-api-library', () => ({...}));
import { YourConnector } from './your-connector';

// BAD — import before mock
import { YourConnector } from './your-connector';
jest.mock('your-api-library', () => ({...}));
```

### Mock returns undefined

Check that you're using the wrapper pattern correctly:

```typescript
// GOOD — wrapper pattern
const mockClientWrapper = { client: createMockClient() };
jest.mock('library', () => ({ Client: jest.fn(() => mockClientWrapper.client) }));

beforeEach(() => {
  mockClientWrapper.client = createMockClient(); // Update the wrapper
  mockClient = mockClientWrapper.client;
});

// BAD — direct reassignment
let mockClient = createMockClient();
jest.mock('library', () => ({ Client: jest.fn(() => mockClient) }));

beforeEach(() => {
  mockClient = createMockClient(); // Doesn't update the mock!
});
```

### TypeScript errors with mock types

Make sure your mock type uses `jest.Mock`:

```typescript
// GOOD
type MockClient = {
  getData: jest.Mock;
};

// BAD
type MockClient = {
  getData: Function;
};
```
