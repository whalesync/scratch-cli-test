import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RateLimiterRes } from 'rate-limiter-flexible';
import { ApiRateLimitGuard } from '../api-rate-limit.guard';

// Mock ioredis — prevent real connections
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
  }));
});

// Mock rate-limiter-flexible
const mockConsume = jest.fn();
jest.mock('rate-limiter-flexible', () => {
  const actual = jest.requireActual<typeof import('rate-limiter-flexible')>('rate-limiter-flexible');
  return {
    ...actual,
    RateLimiterRedis: jest.fn().mockImplementation(() => ({
      consume: mockConsume,
    })),
  };
});

interface MockResponse {
  setHeader: jest.Mock;
}

interface MockExecutionContext {
  context: ExecutionContext;
  response: MockResponse;
}

function createMockExecutionContext(overrides?: {
  user?: Record<string, unknown>;
  handler?: object;
  classRef?: object;
}): MockExecutionContext {
  const response: MockResponse = { setHeader: jest.fn() };
  const mockRequest = { user: overrides?.user };

  const context = {
    switchToHttp: () => ({
      getRequest: () => mockRequest,
      getResponse: () => response,
    }),
    getHandler: () => overrides?.handler ?? (() => undefined),
    getClass: () => overrides?.classRef ?? class {},
  } as unknown as ExecutionContext;

  return { context, response };
}

describe('ApiRateLimitGuard', () => {
  let guard: ApiRateLimitGuard;
  let reflector: Reflector;

  const mockConfigService = {
    getRedisHost: () => 'localhost',
    getRedisPort: () => 6379,
    getRedisPassword: () => '',
    isApiRateLimitDisabled: () => false,
  };

  const mockMetricsService = {
    logValue: jest.fn(),
    withLoggedExecTime: jest.fn(),
    withLoggedExecTimeForConnector: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    reflector = new Reflector();
    guard = new ApiRateLimitGuard(reflector, mockConfigService as never, mockMetricsService);
    guard.onModuleInit();
  });

  afterEach(async () => {
    await guard.onModuleDestroy();
  });

  it('should allow requests without a user (no auth)', async () => {
    const { context } = createMockExecutionContext({ user: undefined });
    expect(await guard.canActivate(context)).toBe(true);
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('should skip rate limiting for JWT auth (web app)', async () => {
    const { context } = createMockExecutionContext({
      user: { id: 'user-1', authType: 'jwt', authSource: 'user' },
    });
    expect(await guard.canActivate(context)).toBe(true);
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('should rate limit API token requests', async () => {
    mockConsume.mockResolvedValueOnce({});
    const { context } = createMockExecutionContext({
      user: { id: 'user-1', authType: 'api-token', authSource: 'cli' },
    });
    expect(await guard.canActivate(context)).toBe(true);
    expect(mockConsume).toHaveBeenCalledWith('user-1', 1);
  });

  it('should throw 429 when rate limit is exceeded', async () => {
    mockConsume.mockRejectedValueOnce(new RateLimiterRes(0, 5000));
    const { context } = createMockExecutionContext({
      user: { id: 'user-1', authType: 'api-token', authSource: 'user' },
    });

    try {
      await guard.canActivate(context);
      fail('Expected HttpException to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const httpError = error as HttpException;
      expect(httpError.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
      const body = httpError.getResponse() as Record<string, unknown>;
      expect(body.retryAfterS).toBe(5);
    }

    expect(mockMetricsService.logValue).toHaveBeenCalledWith('api_rate_limit_exceeded', 1, {
      name: 'authSource',
      value: 'user',
    });
  });

  it('should set Retry-After header on 429', async () => {
    mockConsume.mockRejectedValueOnce(new RateLimiterRes(0, 3000));
    const { context, response } = createMockExecutionContext({
      user: { id: 'user-1', authType: 'api-token', authSource: 'cli' },
    });

    await expect(guard.canActivate(context)).rejects.toThrow(HttpException);
    expect(response.setHeader).toHaveBeenCalledWith('Retry-After', '3');
  });

  it('should fail open on Redis errors', async () => {
    mockConsume.mockRejectedValueOnce(new Error('Redis connection refused'));
    const { context } = createMockExecutionContext({
      user: { id: 'user-1', authType: 'api-token', authSource: 'cli' },
    });
    expect(await guard.canActivate(context)).toBe(true);
  });

  it('should skip rate limiting for tokens with rate-limit:unlimited scope', async () => {
    const { context } = createMockExecutionContext({
      user: { id: 'user-1', authType: 'api-token', authSource: 'cli', apiToken: { scopes: ['rate-limit:unlimited'] } },
    });
    expect(await guard.canActivate(context)).toBe(true);
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('should skip rate limiting when API_RATE_LIMIT_DISABLED is enabled in config', async () => {
    const disabledConfig = { ...mockConfigService, isApiRateLimitDisabled: () => true };
    const disabledGuard = new ApiRateLimitGuard(reflector, disabledConfig as never, mockMetricsService);
    disabledGuard.onModuleInit();
    try {
      const { context } = createMockExecutionContext({
        user: { id: 'user-1', authType: 'api-token', authSource: 'cli', apiToken: { scopes: [] } },
      });
      expect(await disabledGuard.canActivate(context)).toBe(true);
      expect(mockConsume).not.toHaveBeenCalled();
    } finally {
      await disabledGuard.onModuleDestroy();
    }
  });

  it('should skip rate limiting when @SkipApiRateLimit is set on the handler', async () => {
    const handler = () => undefined;
    jest.spyOn(reflector, 'get').mockImplementation((key, target) => {
      if (key === 'API_RATE_LIMIT_SKIP' && target === handler) return true;
      return undefined;
    });
    const { context } = createMockExecutionContext({
      user: { id: 'user-1', authType: 'api-token', authSource: 'cli' },
      handler,
    });
    expect(await guard.canActivate(context)).toBe(true);
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('should skip rate limiting when @SkipApiRateLimit is set on the class', async () => {
    const classRef = class SomeController {};
    jest.spyOn(reflector, 'get').mockImplementation((key, target) => {
      if (key === 'API_RATE_LIMIT_SKIP' && target === classRef) return true;
      return undefined;
    });
    const { context } = createMockExecutionContext({
      user: { id: 'user-1', authType: 'api-token', authSource: 'cli' },
      classRef,
    });
    expect(await guard.canActivate(context)).toBe(true);
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('should use high rate limit spec for tokens with rate-limit:high scope', async () => {
    mockConsume.mockResolvedValueOnce({});
    const { context } = createMockExecutionContext({
      user: { id: 'user-1', authType: 'api-token', authSource: 'cli', apiToken: { scopes: ['rate-limit:high'] } },
    });
    expect(await guard.canActivate(context)).toBe(true);
    expect(mockConsume).toHaveBeenCalledWith('user-1', 1);
  });

  it('should apply default rate limit when token has no special scopes', async () => {
    mockConsume.mockResolvedValueOnce({});
    const { context } = createMockExecutionContext({
      user: { id: 'user-1', authType: 'api-token', authSource: 'cli', apiToken: { scopes: ['read:snapshots'] } },
    });
    expect(await guard.canActivate(context)).toBe(true);
    expect(mockConsume).toHaveBeenCalledWith('user-1', 1);
  });

  it('should apply default rate limit when token has no scopes array', async () => {
    mockConsume.mockResolvedValueOnce({});
    const { context } = createMockExecutionContext({
      user: { id: 'user-1', authType: 'api-token', authSource: 'cli', apiToken: { scopes: undefined } },
    });
    expect(await guard.canActivate(context)).toBe(true);
    expect(mockConsume).toHaveBeenCalledWith('user-1', 1);
  });

  it('should use decorator metadata when present', async () => {
    mockConsume.mockResolvedValueOnce({});
    const handler = () => undefined;
    jest.spyOn(reflector, 'get').mockReturnValue({ points: 10, duration: 30 });
    const { context } = createMockExecutionContext({
      user: { id: 'user-1', authType: 'api-token', authSource: 'user' },
      handler,
    });
    expect(await guard.canActivate(context)).toBe(true);
  });

  it('should consume weight points when @ApiRateLimitWeight is set', async () => {
    mockConsume.mockResolvedValueOnce({});
    const handler = () => undefined;
    jest.spyOn(reflector, 'get').mockImplementation((key) => {
      if (key === 'API_RATE_LIMIT_WEIGHT') return 5;
      return undefined;
    });
    const { context } = createMockExecutionContext({
      user: { id: 'user-1', authType: 'api-token', authSource: 'cli' },
      handler,
    });
    expect(await guard.canActivate(context)).toBe(true);
    expect(mockConsume).toHaveBeenCalledWith('user-1', 5);
  });

  it('should default to weight of 1 when no weight decorator is set', async () => {
    mockConsume.mockResolvedValueOnce({});
    const { context } = createMockExecutionContext({
      user: { id: 'user-1', authType: 'api-token', authSource: 'cli' },
    });
    expect(await guard.canActivate(context)).toBe(true);
    expect(mockConsume).toHaveBeenCalledWith('user-1', 1);
  });
});
