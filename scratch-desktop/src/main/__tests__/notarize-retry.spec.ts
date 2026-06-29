import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

interface RunWithRetriesOptions {
  maxAttempts?: number;
  backoffMs?: number[];
  sleep?: (milliseconds: number) => Promise<void>;
  onFailedAttempt?: (error: unknown, attemptNumber: number) => void | Promise<void>;
  onExhausted?: (error: unknown) => void | Promise<void>;
}

interface NotarizeHookModule {
  runWithRetries: <T>(attemptFn: (attemptNumber: number) => Promise<T>, options?: RunWithRetriesOptions) => Promise<T>;
}

// The afterSign hook is a CommonJS build script (electron-builder requires it at
// build time, where TypeScript isn't available), so load it through a Node
// require and exercise its pure, injectable retry helper directly. `yarn test`
// runs vitest from the scratch-desktop package dir, so resolve from cwd.
const loadCommonJs = createRequire(path.join(process.cwd(), 'vitest.config.mts'));
const { runWithRetries } = loadCommonJs(path.join(process.cwd(), 'scripts', 'notarize.cjs')) as NotarizeHookModule;

describe('runWithRetries (notarize.cjs)', () => {
  it('returns the first success and stops retrying', async () => {
    const attempt = vi.fn<() => Promise<string>>();
    attempt.mockRejectedValueOnce(new Error('transient 1'));
    attempt.mockRejectedValueOnce(new Error('transient 2'));
    attempt.mockResolvedValue('accepted-id');
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>();
    sleep.mockResolvedValue(undefined);

    const result = await runWithRetries(attempt, { maxAttempts: 3, backoffMs: [30_000, 60_000], sleep });

    expect(result).toBe('accepted-id');
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('throws the last error after exhausting attempts and runs onExhausted once', async () => {
    const failure = new Error('always transient');
    const attempt = vi.fn<() => Promise<string>>();
    attempt.mockRejectedValue(failure);
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>();
    sleep.mockResolvedValue(undefined);
    const onFailedAttempt = vi.fn<(error: unknown, attemptNumber: number) => Promise<void>>();
    onFailedAttempt.mockResolvedValue(undefined);
    const onExhausted = vi.fn<(error: unknown) => Promise<void>>();
    onExhausted.mockResolvedValue(undefined);

    await expect(
      runWithRetries(attempt, { maxAttempts: 3, backoffMs: [1, 1], sleep, onFailedAttempt, onExhausted }),
    ).rejects.toBe(failure);

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(onFailedAttempt).toHaveBeenCalledTimes(3);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onExhausted).toHaveBeenCalledWith(failure);
  });

  it('waits the configured backoff between attempts but not after the last', async () => {
    const attempt = vi.fn<() => Promise<string>>();
    attempt.mockRejectedValue(new Error('nope'));
    const sleep = vi.fn<(milliseconds: number) => Promise<void>>();
    sleep.mockResolvedValue(undefined);

    await expect(runWithRetries(attempt, { maxAttempts: 3, backoffMs: [30_000, 60_000], sleep })).rejects.toThrow(
      'nope',
    );

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 30_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 60_000);
  });
});
