import { BUILD } from './_build';

/**
 * Returns the spinner git short-SHA the consuming code was built from, or
 * 'local' when running from a non-publish build (workspace dev, MR builds,
 * any non-publish CI job).
 */
export function getBuild(): string {
  return BUILD;
}
