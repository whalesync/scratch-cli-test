import { isExperimentEnabled } from '../types/user';
import { useCurrentUser } from './use-current-user';

/**
 * Whether the redesigned desktop review surface ("review surface v2", DEV-10617)
 * is enabled for the current user. Gated by the per-user `DESKTOP_REVIEW_SURFACE_V2`
 * flag (resolved server-side, delivered on `GET /users/current`). Defaults false
 * until enabled per-user in PostHog, so the new surfaces ship dark.
 *
 * Phase 0 foundation: no surface consumes this yet — the Phase 2 By-type view and
 * the Phase 5 filter chips gate on it as they land.
 */
export function useReviewSurfaceV2Enabled(): boolean {
  const { user } = useCurrentUser();
  return isExperimentEnabled('DESKTOP_REVIEW_SURFACE_V2', user);
}
