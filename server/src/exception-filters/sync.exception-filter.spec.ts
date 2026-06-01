import { ArgumentsHost } from '@nestjs/common';
import { ConstantTypeMismatchError, SyncMappingNormalizeError, SyncMappingVersionError } from '@spinner/shared-types';
import { WSLogger } from 'src/logger';
import { SyncExceptionFilter } from './sync.exception-filter';

function mockHost({
  params = {},
  method = 'POST',
  url = '/x',
}: {
  params?: Record<string, string>;
  method?: string;
  url?: string;
} = {}): { host: ArgumentsHost; status: jest.Mock; json: jest.Mock } {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const response = { status };
  const request = { params, method, url };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('SyncExceptionFilter', () => {
  const filter = new SyncExceptionFilter();

  beforeEach(() => {
    jest.spyOn(WSLogger, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('maps SyncMappingNormalizeError to 500 SYNC_MAPPING_NORMALIZE_FAILED with syncId + detail', () => {
    const { host, status, json } = mockHost({ params: { syncId: 'sync_123' } });

    filter.catch(new SyncMappingNormalizeError('tableMappings is not an array'), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: 'SYNC_MAPPING_NORMALIZE_FAILED',
      syncId: 'sync_123',
      detail: 'tableMappings is not an array',
    });
  });

  it('maps SyncMappingVersionError to 500 SYNC_MAPPING_UNKNOWN_VERSION with the received version', () => {
    const { host, status, json } = mockHost({ params: { syncId: 'sync_123' } });

    filter.catch(new SyncMappingVersionError(99), host);

    expect(status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({
      error: 'SYNC_MAPPING_UNKNOWN_VERSION',
      syncId: 'sync_123',
      version: 99,
    });
  });

  it('maps ConstantTypeMismatchError to 400 INVALID_CONSTANT_TYPE with column + types', () => {
    const { host, status, json } = mockHost({ params: { syncId: 'sync_123' } });

    filter.catch(new ConstantTypeMismatchError('archived', 'boolean', 'string'), host);

    expect(status).toHaveBeenCalledWith(400);
    expect(json).toHaveBeenCalledWith({
      error: 'INVALID_CONSTANT_TYPE',
      destinationColumnId: 'archived',
      expected: 'boolean',
      got: 'string',
    });
  });

  it('sets syncId to null when no :syncId route param is present (e.g. create)', () => {
    const { host, json } = mockHost({ params: {}, method: 'POST', url: '/workbooks/wb_1/syncs' });

    filter.catch(new SyncMappingNormalizeError('mapping is not an object'), host);

    expect(json).toHaveBeenCalledWith({
      error: 'SYNC_MAPPING_NORMALIZE_FAILED',
      syncId: null,
      detail: 'mapping is not an object',
    });
  });
});
