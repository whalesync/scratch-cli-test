/**
 * Map an async function over `items` with at most `maxConcurrentTasks` running at
 * once, returning the results in input order and rejecting with the first error
 * encountered. On error, workers stop pulling new items and any already-in-flight
 * tasks settle first (no unhandled rejections), then the first error is thrown —
 * the fail-fast semantics of a sequential `await` loop, with the work fanned out.
 *
 * Used by connectors to fetch many records' details at once instead of one record
 * at a time: HighLevel contacts' sub-entities (DEV-10499) and Intercom
 * conversations in full. The caller's rate limiter still sets the request rate;
 * this only bounds how much work is in flight.
 */
export async function mapWithBoundedConcurrency<Item, Result>(
  items: Item[],
  maxConcurrentTasks: number,
  mapItemToResult: (item: Item, index: number) => Promise<Result>,
): Promise<Result[]> {
  const resultsInInputOrder = new Array<Result>(items.length);
  let nextItemIndexToProcess = 0;
  let firstErrorEncountered: unknown;
  let hasErrorBeenEncountered = false;

  const runWorker = async (): Promise<void> => {
    while (!hasErrorBeenEncountered) {
      const currentItemIndex = nextItemIndexToProcess;
      nextItemIndexToProcess += 1;
      if (currentItemIndex >= items.length) return;
      try {
        resultsInInputOrder[currentItemIndex] = await mapItemToResult(items[currentItemIndex], currentItemIndex);
      } catch (error) {
        if (!hasErrorBeenEncountered) {
          hasErrorBeenEncountered = true;
          firstErrorEncountered = error;
        }
        return;
      }
    }
  };

  const workerCount = Math.min(maxConcurrentTasks, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  if (hasErrorBeenEncountered) throw firstErrorEncountered;
  return resultsInInputOrder;
}
