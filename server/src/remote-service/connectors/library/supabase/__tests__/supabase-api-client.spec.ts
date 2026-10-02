import { AxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { isDuplicateTableError, isInsufficientPrivilegeError } from '../../pg-common';
import {
  isSupabaseManagementApiRateLimitError,
  parsePostgresSqlStateFromManagementApiErrorMessage,
  SUPABASE_MANAGEMENT_API_RETRY_OPTS,
  SupabaseApiClient,
  SupabaseApiError,
} from '../supabase-api-client';

/**
 * How Management API failures surface from the client (DEV-12084): a statement that fails inside
 * `/database/query` carries its Postgres SQLSTATE, so the connector's shared `isDuplicateTableError` /
 * `isInsufficientPrivilegeError` checks work on DDL sent through the Management API exactly as on DDL
 * sent over a `pg` connection; and a rate-limited request is retried rather than failed.
 */

const mockGet = jest.fn();
const mockPost = jest.fn();

jest.mock('../../../create-api-client', () => ({
  createApiClient: jest.fn(() => ({ get: mockGet, post: mockPost })),
}));

const PROJECT_REF = 'abcdefghijklmnopqrst';

/** A raw AxiosError carrying the given HTTP status and response body, as `wrapError` receives it. */
function axiosErrorWithResponse(status: number, data: unknown): AxiosError {
  return Object.assign(new AxiosError(`Request failed with status code ${status}`), {
    response: { status, data, statusText: '', headers: {}, config: {} },
  });
}

describe('SupabaseApiClient.executeQuery', () => {
  let client: SupabaseApiClient;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    mockPost.mockReset();
    warnSpy = jest.spyOn(WSLogger, 'warn').mockImplementation(() => undefined);
    client = new SupabaseApiClient('supabase-management-token');
  });

  afterEach(() => {
    warnSpy.mockRestore();
    jest.useRealTimers();
  });

  async function executeQueryRejection(): Promise<unknown> {
    return client.executeQuery(PROJECT_REF, 'create table "public"."users" ("id" uuid)').then(
      () => {
        throw new Error('expected executeQuery to reject');
      },
      (error: unknown) => error,
    );
  }

  describe('a failed statement', () => {
    it('carries its SQLSTATE, so the shared insufficient-privilege check recognizes it', async () => {
      mockPost.mockRejectedValueOnce(
        axiosErrorWithResponse(400, { message: 'ERROR:  42501: permission denied for schema gong' }),
      );

      const error = await executeQueryRejection();

      expect(error).toBeInstanceOf(SupabaseApiError);
      expect(error).toMatchObject({ statusCode: 400, code: '42501' });
      expect((error as SupabaseApiError).message).toContain('permission denied for schema gong');
      expect(isInsufficientPrivilegeError(error)).toBe(true);
      expect(isDuplicateTableError(error)).toBe(false);
    });

    it('recognizes a duplicate table in the dashboard-style message, LINE and caret lines included', async () => {
      mockPost.mockRejectedValueOnce(
        axiosErrorWithResponse(400, {
          message:
            'Failed to run sql query: ERROR:  42P07: relation "users" already exists\nLINE 1: create table "public"."users" ("id" uuid)\n                     ^\n',
        }),
      );

      const error = await executeQueryRejection();

      expect(isDuplicateTableError(error)).toBe(true);
    });

    it('reads the SQL error out of an { error } body as well', async () => {
      mockPost.mockRejectedValueOnce(
        axiosErrorWithResponse(400, { error: 'ERROR:  42P01: relation "public.missing" does not exist' }),
      );

      const error = await executeQueryRejection();

      expect(error).toMatchObject({ statusCode: 400, code: '42P01' });
      expect((error as SupabaseApiError).message).toContain('relation "public.missing" does not exist');
    });

    it('is not retried', async () => {
      mockPost.mockRejectedValueOnce(
        axiosErrorWithResponse(400, { message: 'ERROR:  42501: must be owner of table users' }),
      );

      await executeQueryRejection();

      expect(mockPost).toHaveBeenCalledTimes(1);
    });
  });

  describe('a failure that is not a SQL error', () => {
    it('carries no SQLSTATE', async () => {
      mockPost.mockRejectedValueOnce(axiosErrorWithResponse(400, { message: 'Project is paused' }));

      const error = await executeQueryRejection();

      expect(error).toBeInstanceOf(SupabaseApiError);
      expect(error).toMatchObject({ statusCode: 400, code: undefined });
    });

    it('keeps the 403 message, with no SQLSTATE even if the body mentions one', async () => {
      mockPost.mockRejectedValueOnce(
        axiosErrorWithResponse(403, { message: 'ERROR:  42501: permission denied for schema gong' }),
      );

      const error = await executeQueryRejection();

      expect(error).toMatchObject({ statusCode: 403, code: undefined });
      expect((error as SupabaseApiError).message).toBe(
        `Insufficient permissions for Supabase API (/projects/${PROJECT_REF}/database/query).`,
      );
    });

    it('keeps the 401 reconnect message', async () => {
      mockPost.mockRejectedValueOnce(axiosErrorWithResponse(401, { message: 'JWT expired' }));

      const error = await executeQueryRejection();

      expect(error).toMatchObject({ statusCode: 401, code: undefined });
      expect((error as SupabaseApiError).message).toBe('Supabase authorization failed. Please reconnect your account.');
    });

    it('passes a non-HTTP failure through unchanged', async () => {
      const socketError = new Error('socket hang up');
      mockPost.mockRejectedValueOnce(socketError);

      const error = await executeQueryRejection();

      expect(error).toBe(socketError);
      expect(mockPost).toHaveBeenCalledTimes(1);
    });
  });

  describe('a rate-limited request (429)', () => {
    it('is retried after the backoff and returns the eventual result', async () => {
      jest.useFakeTimers();
      mockPost
        .mockRejectedValueOnce(axiosErrorWithResponse(429, { message: 'Too many requests' }))
        .mockResolvedValueOnce({ data: [{ current_user: 'postgres' }] });

      const resultPromise = client.executeQuery(PROJECT_REF, 'select current_user');
      await jest.advanceTimersByTimeAsync(SUPABASE_MANAGEMENT_API_RETRY_OPTS.initialRetryDelayMs ?? 0);

      await expect(resultPromise).resolves.toEqual([{ current_user: 'postgres' }]);
      expect(mockPost).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });
  });
});

describe('parsePostgresSqlStateFromManagementApiErrorMessage', () => {
  it.each([
    ['ERROR:  42P07: relation "users" already exists', '42P07'],
    ['Failed to run sql query: ERROR:  42501: must be owner of table objects', '42501'],
    ['ERROR: 42601: syntax error at or near "selec"', '42601'],
    ['FATAL:  53300: sorry, too many clients already', '53300'],
    ['Supabase API error (400): ERROR:  42701: column "bio" of relation "users" already exists\nHINT:  …', '42701'],
  ])('reads the SQLSTATE out of %j', (message, expectedSqlState) => {
    expect(parsePostgresSqlStateFromManagementApiErrorMessage(message)).toBe(expectedSqlState);
  });

  it.each(['Project is paused', '', 'ERROR: relation "users" already exists', 'Request failed with status code 500'])(
    'finds nothing in %j',
    (message) => {
      expect(parsePostgresSqlStateFromManagementApiErrorMessage(message)).toBeUndefined();
    },
  );
});

describe('isSupabaseManagementApiRateLimitError', () => {
  it('is true only for a SupabaseApiError with status 429', () => {
    expect(
      isSupabaseManagementApiRateLimitError(new SupabaseApiError('Supabase API error (429): slow down', 429)),
    ).toBe(true);
    expect(isSupabaseManagementApiRateLimitError(new SupabaseApiError('Supabase API error (400)', 400, '42501'))).toBe(
      false,
    );
    expect(isSupabaseManagementApiRateLimitError(axiosErrorWithResponse(429, {}))).toBe(false);
    expect(isSupabaseManagementApiRateLimitError(new Error('429'))).toBe(false);
    expect(isSupabaseManagementApiRateLimitError(null)).toBe(false);
  });
});
