import { useEffect, useState } from 'react';
import { isVersionBelowMinimum } from '../lib/version-compare';

export interface ForceUpgradeState {
  /**
   * True only once we know the running version AND it is strictly older than the
   * server-declared minimum. Stays false while the version is still resolving so
   * the app never flashes the lock screen before we can actually compare.
   */
  isUpgradeRequired: boolean;
  /** The running desktop-app version, or null until it has been resolved. */
  currentVersion: string | null;
  /** The server-declared minimum supported version, or null when none is set. */
  minimumVersion: string | null;
}

/**
 * Decides whether the desktop app must force an upgrade (DEV-10735). Compares the
 * running build's version against the `minimumDesktopClientVersion` the server
 * returns on `/users/current`. When the build is older, the caller locks the UI
 * and routes the user through the autoupdater.
 *
 * Never enforces in the dev renderer (`yarn dev`): it would lock developers out,
 * and the autoupdater the lock screen relies on is itself disabled in unpackaged
 * builds. It is also fail-open — an unset minimum, an unparseable version, or a
 * not-yet-resolved running version all yield `isUpgradeRequired: false`.
 */
export function useForceUpgrade(minimumDesktopClientVersion: string | undefined): ForceUpgradeState {
  const [currentVersion, setCurrentVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const version = await window.scratchDesktop?.getAppVersion();
      if (!cancelled && version) {
        setCurrentVersion(version);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const minimumVersion = minimumDesktopClientVersion ?? null;

  // The dev renderer must never lock: developers run an arbitrary version and the
  // packaged autoupdater is unavailable, so there would be no way out.
  if (import.meta.env.DEV) {
    return { isUpgradeRequired: false, currentVersion, minimumVersion };
  }

  const isUpgradeRequired =
    minimumVersion !== null && currentVersion !== null && isVersionBelowMinimum(currentVersion, minimumVersion);

  return { isUpgradeRequired, currentVersion, minimumVersion };
}
