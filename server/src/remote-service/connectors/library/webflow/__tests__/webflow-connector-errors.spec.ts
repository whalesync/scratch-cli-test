import axios from 'axios';
import { BaseJsonTableSpec, ConnectorFile } from '../../../types';
import { WebflowConnector } from '../webflow-connector';

// Mock display-names to break the circular import chain (it imports all connectors).
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Webflow'),
}));

// Mock the WebflowApiClient so the connector's `this.client` is the mock.
const mockDeleteItemsLive = jest.fn();
const mockDeleteItems = jest.fn();
jest.mock('../webflow-api-client', () => ({
  WebflowApiClient: jest.fn().mockImplementation(() => ({
    deleteItemsLive: mockDeleteItemsLive,
    deleteItems: mockDeleteItems,
  })),
  WebflowError: class WebflowError extends Error {},
}));

/** Build an axios error carrying a given HTTP status + response body. */
function makeAxiosError(status: number, data: unknown): axios.AxiosError {
  return new axios.AxiosError(`Request failed with status code ${status}`, String(status), undefined, undefined, {
    status,
    statusText: '',
    headers: {},
    config: {} as never,
    data,
  });
}

const tableSpec = {
  id: { wsId: 'site1::col1', remoteId: ['site1', 'col1'] },
} as unknown as BaseJsonTableSpec;

describe('WebflowConnector error handling', () => {
  let connector: WebflowConnector;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new WebflowConnector('test-token');
  });

  describe('extractConnectorErrorDetails', () => {
    it('maps the CMS plan-limit 409 to a friendly message', () => {
      const error = makeAxiosError(409, {
        message: "You've created all the items in your CMS Database allowed on your current plan.",
      });
      expect(connector.extractConnectorErrorDetails(error)).toEqual({
        userFriendlyMessage: 'You have reached the maximum number of CMS items allowed for your plan.',
      });
    });

    it('joins every per-error message from an `errors` array', () => {
      const error = makeAxiosError(400, {
        errors: [{ message: 'Field "slug" is required' }, { message: 'Field "name" is too long' }],
      });
      const details = connector.extractConnectorErrorDetails(error);
      expect(details.userFriendlyMessage).toBe('Field "slug" is required; Field "name" is too long');
      expect(details.description).toBe('Field "slug" is required; Field "name" is too long');
    });

    it('joins per-error messages from a v2 `details` array', () => {
      const error = makeAxiosError(400, { details: [{ message: 'bad value' }, { message: 'also bad' }] });
      expect(connector.extractConnectorErrorDetails(error).userFriendlyMessage).toBe('bad value; also bad');
    });

    it('falls back to the top-level message when there is no error array', () => {
      const error = makeAxiosError(400, { message: 'Validation failed' });
      expect(connector.extractConnectorErrorDetails(error).userFriendlyMessage).toBe('Validation failed');
    });

    it('maps 401 to the shared unauthorized message', () => {
      const error = makeAxiosError(401, { message: 'unauthorized' });
      expect(connector.extractConnectorErrorDetails(error).userFriendlyMessage).toMatch(/no longer valid/);
    });

    it('maps 403 to a distinct insufficient-permission message (not "no longer valid")', () => {
      const error = makeAxiosError(403, { message: 'forbidden' });
      const message = connector.extractConnectorErrorDetails(error).userFriendlyMessage;
      expect(message).toMatch(/permission/i);
      expect(message).not.toMatch(/no longer valid/);
    });
  });

  describe('deleteRecords (404 swallow contract)', () => {
    const files = [{ id: 'i1' } as ConnectorFile];

    it('swallows a 404 from the live-unpublish step and proceeds to the CMS delete', async () => {
      mockDeleteItemsLive.mockRejectedValue(makeAxiosError(404, { code: 'item_not_found' }));
      mockDeleteItems.mockResolvedValue(undefined);
      await expect(connector.deleteRecords(tableSpec, files)).resolves.toBeUndefined();
      expect(mockDeleteItems).toHaveBeenCalledWith('col1', { items: [{ id: 'i1' }] });
    });

    it('swallows a 404 from the CMS delete step (already deleted)', async () => {
      mockDeleteItemsLive.mockResolvedValue(undefined);
      mockDeleteItems.mockRejectedValue(makeAxiosError(404, { code: 'item_not_found' }));
      await expect(connector.deleteRecords(tableSpec, files)).resolves.toBeUndefined();
    });

    it('re-throws a non-404 error from the live-unpublish step', async () => {
      mockDeleteItemsLive.mockRejectedValue(makeAxiosError(500, { message: 'boom' }));
      await expect(connector.deleteRecords(tableSpec, files)).rejects.toThrow(/status code 500/);
      expect(mockDeleteItems).not.toHaveBeenCalled();
    });

    it('re-throws a non-404 error from the CMS delete step', async () => {
      mockDeleteItemsLive.mockResolvedValue(undefined);
      mockDeleteItems.mockRejectedValue(makeAxiosError(409, { message: 'conflict' }));
      await expect(connector.deleteRecords(tableSpec, files)).rejects.toThrow(/status code 409/);
    });
  });
});
