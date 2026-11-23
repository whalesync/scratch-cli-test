import { ConfigService } from '@nestjs/config';
import { ScratchConfigService } from '../scratch-config.service';

/**
 * Regression coverage for DEV-11398: a disallowed CORS origin must be denied via
 * `callback(null, false)` (a clean CORS rejection), NOT `callback(new Error(...))`.
 * Throwing produced a plain, non-HttpException Error that NestJS mapped to HTTP 500,
 * turning routine spam-origin rejections into false-positive server errors.
 */
describe('ScratchConfigService.getCorsAllowedOrigins', () => {
  const originalAppEnv = process.env.APP_ENV;
  const originalClientBaseUrl = process.env.CLIENT_BASE_URL;
  const originalWhalesyncOrigins = process.env.WHALESYNC_APP_ORIGINS;

  beforeEach(() => {
    // Development env → client base URL defaults to http://localhost:3000, no Whalesync origins.
    process.env.APP_ENV = 'development';
    process.env.CLIENT_BASE_URL = 'http://localhost:3000';
    delete process.env.WHALESYNC_APP_ORIGINS;
  });

  afterEach(() => {
    restoreEnvVariable('APP_ENV', originalAppEnv);
    restoreEnvVariable('CLIENT_BASE_URL', originalClientBaseUrl);
    restoreEnvVariable('WHALESYNC_APP_ORIGINS', originalWhalesyncOrigins);
  });

  function restoreEnvVariable(name: string, originalValue: string | undefined): void {
    if (originalValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalValue;
    }
  }

  function invokeOriginCallbackWith(origin: string | undefined): { error: Error | null; allowed: boolean | undefined } {
    const corsOriginCallback = ScratchConfigService.getCorsAllowedOrigins();
    let capturedError: Error | null = null;
    let capturedAllowedFlag: boolean | undefined;
    corsOriginCallback(origin, (error, allow) => {
      capturedError = error;
      capturedAllowedFlag = allow;
    });
    return { error: capturedError, allowed: capturedAllowedFlag };
  }

  it('rejects a disallowed origin with callback(null, false), never a thrown Error', () => {
    const { error, allowed } = invokeOriginCallbackWith('https://evil.example.com');
    // The critical assertion: no Error is passed (which would become an HTTP 500).
    expect(error).toBeNull();
    expect(allowed).toBe(false);
  });

  it('allows the configured client origin', () => {
    const { error, allowed } = invokeOriginCallbackWith('http://localhost:3000');
    expect(error).toBeNull();
    expect(allowed).toBe(true);
  });

  it('allows requests with no Origin header (Electron file://, server-to-server, curl)', () => {
    const { error, allowed } = invokeOriginCallbackWith(undefined);
    expect(error).toBeNull();
    expect(allowed).toBe(true);
  });

  it('allows a configured Whalesync (Dusky) shadow-user origin', () => {
    process.env.WHALESYNC_APP_ORIGINS = 'https://app.whalesync.com, https://dusky.whalesync.com';
    const { error, allowed } = invokeOriginCallbackWith('https://dusky.whalesync.com');
    expect(error).toBeNull();
    expect(allowed).toBe(true);
  });
});

describe('ScratchConfigService table spec flags (DEV-12616)', () => {
  function createScratchConfigServiceWithEnvironment(
    environmentVariables: Record<string, string>,
  ): ScratchConfigService {
    // CI has no APP_ENV or .env, so pin the statics the constructor reads.
    jest.spyOn(ScratchConfigService, 'getScratchEnvironment').mockReturnValue('test');
    jest.spyOn(ScratchConfigService, 'getServiceTypes').mockReturnValue([]);
    const configServiceReadingOnlyTheseVariables = {
      get: (name: string) => ({ DATABASE_URL: 'postgresql://localhost/test', ...environmentVariables })[name],
    } as unknown as ConfigService;
    return new ScratchConfigService(configServiceReadingOnlyTheseVariables);
  }

  afterEach(() => jest.restoreAllMocks());

  it('reads table specs from Postgres by default, and rolls back to git when TABLE_SPEC_POSTGRES_READS_ENABLED=false', () => {
    expect(createScratchConfigServiceWithEnvironment({}).isTableSpecPostgresReadsEnabled()).toBe(true);
    expect(
      createScratchConfigServiceWithEnvironment({
        TABLE_SPEC_POSTGRES_READS_ENABLED: 'false',
      }).isTableSpecPostgresReadsEnabled(),
    ).toBe(false);
  });

  it('mirrors writes to git by default', () => {
    expect(createScratchConfigServiceWithEnvironment({}).isTableSpecGitMirrorEnabled()).toBe(true);
  });
});
