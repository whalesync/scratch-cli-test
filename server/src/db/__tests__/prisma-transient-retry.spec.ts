import { Prisma } from '@prisma/client';
import { isTransientPrismaConnectionError, retryOnTransientDbConnectionError } from '../prisma-transient-retry';

function makeKnownRequestError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`simulated ${code}`, { code, clientVersion: 'test' });
}

describe('isTransientPrismaConnectionError', () => {
  it('is true for the transient connection codes P1001 (unreachable) and P2024 (pool timeout)', () => {
    expect(isTransientPrismaConnectionError(makeKnownRequestError('P1001'))).toBe(true);
    expect(isTransientPrismaConnectionError(makeKnownRequestError('P2024'))).toBe(true);
  });

  it('is true for a P1001 initialization error (cold $connect that cannot reach the server)', () => {
    const initError = new Prisma.PrismaClientInitializationError('no connection', 'test', 'P1001');
    expect(isTransientPrismaConnectionError(initError)).toBe(true);
  });

  it('is false for a non-transient Prisma error (P2002), a plain Error, and non-error values', () => {
    expect(isTransientPrismaConnectionError(makeKnownRequestError('P2002'))).toBe(false);
    expect(isTransientPrismaConnectionError(new Error('boom'))).toBe(false);
    expect(isTransientPrismaConnectionError(null)).toBe(false);
    expect(isTransientPrismaConnectionError(undefined)).toBe(false);
  });
});

describe('retryOnTransientDbConnectionError', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('retries a transient connection error and then returns the eventual success value', async () => {
    const onRetry = jest.fn();
    const fn = jest.fn().mockRejectedValueOnce(makeKnownRequestError('P2024')).mockResolvedValueOnce('ok');

    const promise = retryOnTransientDbConnectionError(fn, { onRetry, initialRetryDelayMs: 500 });
    await jest.advanceTimersByTimeAsync(600);

    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ attempt: 1, delayMs: 500 }));
  });

  it('rethrows the original error, unwrapped, after exhausting the retry budget', async () => {
    const onRetry = jest.fn();
    const transientError = makeKnownRequestError('P1001');
    const fn = jest.fn().mockRejectedValue(transientError);

    const promise = retryOnTransientDbConnectionError(fn, { onRetry, maxAttempts: 3, initialRetryDelayMs: 10 });
    const assertion = expect(promise).rejects.toBe(transientError);
    await jest.advanceTimersByTimeAsync(10_000);
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3); // maxAttempts
    expect(onRetry).toHaveBeenCalledTimes(2); // maxAttempts - 1: no onRetry on the final, failing attempt
  });

  it('rethrows a non-transient error immediately without retrying or sleeping', async () => {
    const onRetry = jest.fn();
    const nonTransientError = makeKnownRequestError('P2002');
    const fn = jest.fn().mockRejectedValue(nonTransientError);

    await expect(retryOnTransientDbConnectionError(fn, { onRetry })).rejects.toBe(nonTransientError);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });
});
