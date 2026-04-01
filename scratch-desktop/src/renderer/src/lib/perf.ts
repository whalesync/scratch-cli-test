export function logPerf(message: string, elapsedMs: number): void {
  console.debug(`[perf] ${message}: ${elapsedMs.toFixed(1)}ms`);
}
