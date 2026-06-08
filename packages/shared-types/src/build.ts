import { BUILD } from './_build';

/**
 * Returns the @spinner/shared-types version the consuming code was built with
 * (e.g. '0.0.0-master-b9126270'), or 'local' when running from a build that
 * doesn't bake a version (workspace dev, MR builds, any non-publish/non-image CI).
 */
export function getBuild(): string {
  return BUILD;
}
