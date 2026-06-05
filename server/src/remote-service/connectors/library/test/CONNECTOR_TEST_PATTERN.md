# Connector Test Pattern

This document describes the standardized pattern for testing connectors.

## Overview

All connector tests should follow a consistent structure to ensure:

- **Completeness**: All critical methods are tested
- **Maintainability**: Tests are easy to understand and update
- **Efficiency**: Tests use minimal data to avoid memory issues
- **Consistency**: All connectors are tested the same way

## The Connector Abstract Class

Every connector extends `Connector<T extends Service, TConnectorProgress>` from `connector.ts`.

### Key Types

- **`BaseJsonTableSpec`** — Table definition with `id: EntityId`, `slug`, `name`, `schema: TSchema` (JSON Schema), `idColumnRemoteId`, and optional `titleColumnRemoteId`, `mainContentColumnRemoteId`, `slugColumnRemoteId`
- **`ConnectorFile`** — `Record<string, unknown>` representing a single record as JSON
- **`EntityId`** — `{ wsId: string; remoteId: string[] }`
- **`ConnectorErrorDetails`** — `{ userFriendlyMessage: string; description?: string; additionalContext?: Record<string, unknown> }`
- **`Service`** — Enum imported from `@spinner/shared-types` (not `@prisma/client`)

## Required Tests

Every connector test file MUST include tests for:

1. `pullRecordFiles` — basic download and JSON file transformation
2. `pullRecordFiles` — pagination handling
3. `displayName` — static property returns correct connector name
4. `service` — has correct `Service` enum value
5. `getBatchSize(operation)` — returns valid batch sizes for each operation type
6. `testConnection()` — validates connection succeeds and throws on failure
7. `extractConnectorErrorDetails(error)` — translates service-specific errors

## Testing Pattern

Follow the structure in `connector-test-example.md`:

```typescript
describe('YourConnector', () => {
  let connector: YourConnector;
  let mockClient: MockClient;

  beforeEach(() => {
    // Set up mocks
  });

  describe('pullRecordFiles', () => {
    it('should pull record files and transform to JSON', async () => {
      // Test basic download
    });

    it('should handle pagination correctly', async () => {
      // Test pagination
    });
  });

  describe('displayName', () => {
    it('should return correct display name', () => {
      expect(YourConnector.displayName).toBe('YourService');
    });
  });

  describe('service', () => {
    it('should have correct service type', () => {
      expect(connector.service).toBe(Service.YOUR_SERVICE);
    });
  });

  describe('getBatchSize', () => {
    it('should return batch sizes for each operation', () => {
      expect(connector.getBatchSize('create')).toBeGreaterThan(0);
      expect(connector.getBatchSize('update')).toBeGreaterThan(0);
      expect(connector.getBatchSize('delete')).toBeGreaterThan(0);
    });
  });

  describe('testConnection', () => {
    it('should resolve when connection is valid', async () => {
      mockClient.someAuthCheck.mockResolvedValue({});
      await expect(connector.testConnection()).resolves.toBeUndefined();
    });

    it('should throw when connection fails', async () => {
      mockClient.someAuthCheck.mockRejectedValue(new Error('Unauthorized'));
      await expect(connector.testConnection()).rejects.toThrow();
    });
  });

  describe('extractConnectorErrorDetails', () => {
    it('should return user-friendly error details', () => {
      const error = new YourApiError('Rate limit exceeded', 429);
      const details = connector.extractConnectorErrorDetails(error);
      expect(details.userFriendlyMessage).toBeDefined();
    });
  });
});
```

## Key Testing Principles

### 1. Mock the API Client, Not Internals

```typescript
// GOOD: Mock the connector's api-client so `this.client` is your mock
jest.mock('../webflow-api-client', () => ({
  WebflowApiClient: jest.fn().mockImplementation(() => mockClient),
}));

// BAD: Mock HTTP internals or make real API calls
jest.mock('https');
```

### 2. Use Minimal Test Data

```typescript
// GOOD: 2-3 records, 1-2 fields
const mockFiles: ConnectorFile[] = [
  { id: 'item1', name: 'Test 1' },
  { id: 'item2', name: 'Test 2' },
];

// BAD: Hundreds of records, dozens of fields
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
- Connector-specific features (rich text, metadata, etc.)

Don't test:

- The API client/SDK itself
- Network layer
- Every possible field type combination

## Pagination Patterns in the Codebase

Different connectors use different pagination strategies:

| Connector | Pattern        | Key Mechanism                                         |
| --------- | -------------- | ----------------------------------------------------- |
| Notion    | Cursor-based   | `start_cursor` / `next_cursor` with progress tracking |
| Webflow   | Offset-based   | `offset` / `limit` with total count                   |
| Airtable  | Async iterator | `for await (const batch of client.listRecords(...))`  |

## Files

- `connector-test-example.md` — Detailed examples and patterns
- `CONNECTOR_TEST_PATTERN.md` — This file

## Adding Tests for a New Connector

1. **Create mock client**:

   ```typescript
   const createMockClient = () => ({
     // Only methods your connector actually uses
   });
   ```

2. **Mock the API library**:

   ```typescript
   jest.mock('your-api-library', () => ({ ... }));
   ```

3. **Write required tests**:
   - `pullRecordFiles` — download + transform
   - `pullRecordFiles` — pagination
   - `displayName` (static property)
   - `service` property
   - `getBatchSize(operation)` for all three operation types
   - `testConnection` success and failure
   - `extractConnectorErrorDetails` for service-specific errors

4. **Add connector-specific tests**:
   - Rich text conversion
   - `getNewFile` template generation
   - `validateFiles` if implemented
   - Special field types or schema handling

5. **Keep it minimal**:
   - 1-2 fields in `BaseJsonTableSpec` schemas
   - 2-3 records in test data
   - Focus on core logic

## Testing Checklist

When reviewing connector tests, verify:

- [ ] Mocks the API client (not internals)
- [ ] Uses minimal data (2-3 records, 1-2 fields)
- [ ] Tests `pullRecordFiles` basic functionality
- [ ] Tests `pullRecordFiles` pagination
- [ ] Tests `displayName` static property
- [ ] Tests `service` property
- [ ] Tests `getBatchSize(operation)` for all operation types
- [ ] Tests `testConnection` success and failure
- [ ] Tests `extractConnectorErrorDetails`
- [ ] Includes connector-specific tests (if applicable)
- [ ] All tests pass without memory errors
- [ ] No ESLint warnings
