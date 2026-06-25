import { mapWithBoundedConcurrency } from '../gohighlevel-connector';

describe('mapWithBoundedConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    // Later items resolve sooner, so completion order is the reverse of input order.
    const items = [10, 20, 30, 40, 50];
    const results = await mapWithBoundedConcurrency(items, 3, async (value, index) => {
      await delay(value % 30); // 10ms, 20ms, 0ms, 10ms, 20ms — deliberately out of order
      return { value, index };
    });
    expect(results).toEqual([
      { value: 10, index: 0 },
      { value: 20, index: 1 },
      { value: 30, index: 2 },
      { value: 40, index: 3 },
      { value: 50, index: 4 },
    ]);
  });

  it('never runs more than `maxConcurrentTasks` at once', async () => {
    let currentlyRunning = 0;
    let observedPeakConcurrency = 0;
    const items = Array.from({ length: 25 }, (_unused, index) => index);

    await mapWithBoundedConcurrency(items, 4, async (value) => {
      currentlyRunning += 1;
      observedPeakConcurrency = Math.max(observedPeakConcurrency, currentlyRunning);
      await delay(5);
      currentlyRunning -= 1;
      return value;
    });

    expect(observedPeakConcurrency).toBeLessThanOrEqual(4);
    // With 25 items and a limit of 4 it should actually reach the cap.
    expect(observedPeakConcurrency).toBe(4);
  });

  it('processes every item exactly once', async () => {
    const items = Array.from({ length: 50 }, (_unused, index) => index);
    const processed: number[] = [];
    const results = await mapWithBoundedConcurrency(items, 7, (value) => {
      processed.push(value);
      return Promise.resolve(value * 2);
    });
    expect(processed.sort((a, b) => a - b)).toEqual(items);
    expect(results).toEqual(items.map((value) => value * 2));
  });

  it('runs sequentially-equivalent for an empty list (no workers, no throw)', async () => {
    const mapper = jest.fn((value: number) => Promise.resolve(value));
    const results = await mapWithBoundedConcurrency<number, number>([], 5, mapper);
    expect(results).toEqual([]);
    expect(mapper).not.toHaveBeenCalled();
  });

  it('rejects with the first error and stops scheduling new work', async () => {
    const items = Array.from({ length: 20 }, (_unused, index) => index);
    const startedIndexes: number[] = [];

    await expect(
      mapWithBoundedConcurrency(items, 2, async (value) => {
        startedIndexes.push(value);
        await delay(2);
        if (value === 1) throw new Error('boom at index 1');
        return value;
      }),
    ).rejects.toThrow('boom at index 1');

    // With a concurrency of 2, once index 1 throws no further items past the
    // in-flight pair should be picked up — far short of all 20.
    expect(startedIndexes.length).toBeLessThan(items.length);
    // Cancellation is cooperative, so let any in-flight microtasks settle.
    await delay(10);
  });

  it('treats an empty result ([]) as a real value, not a skip', async () => {
    const results = await mapWithBoundedConcurrency([0, 1, 2], 2, () => Promise.resolve([]));
    expect(results).toEqual([[], [], []]);
  });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
