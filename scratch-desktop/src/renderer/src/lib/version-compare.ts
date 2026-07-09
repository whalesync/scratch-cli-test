/**
 * Minimal semver comparison for the desktop force-upgrade gate (DEV-10735).
 *
 * The desktop app has no direct `semver` dependency, and the only comparison it
 * needs is "is the running build older than the server-declared minimum?". This
 * implements just enough of the semver precedence rules for that: numeric core
 * (major.minor.patch) compared field-by-field, with a prerelease (`-alpha.1`)
 * sorting *below* the same core release. Build metadata (`+sha`) is ignored, per
 * semver. Anything unparseable is treated as "can't tell" so callers can
 * fail-open rather than lock a user out on a malformed version string.
 */

interface ParsedVersion {
  core: number[];
  prerelease: string | null;
}

function parseVersion(rawVersion: string): ParsedVersion | null {
  // Strip a leading `v` and any `+build.metadata` suffix.
  const withoutBuildMetadata = rawVersion.trim().replace(/^v/i, '').replace(/\+.*$/, '');
  if (withoutBuildMetadata === '') {
    return null;
  }

  const dashIndex = withoutBuildMetadata.indexOf('-');
  const corePart = dashIndex === -1 ? withoutBuildMetadata : withoutBuildMetadata.slice(0, dashIndex);
  const prereleasePart = dashIndex === -1 ? null : withoutBuildMetadata.slice(dashIndex + 1) || null;

  const core = corePart.split('.').map((segment) => Number.parseInt(segment, 10));
  if (core.length === 0 || core.some((segment) => Number.isNaN(segment))) {
    return null;
  }

  return { core, prerelease: prereleasePart };
}

/**
 * Returns -1 / 0 / 1 comparing two semver strings, or `null` when either side is
 * unparseable.
 */
export function compareVersions(versionA: string, versionB: string): number | null {
  const parsedA = parseVersion(versionA);
  const parsedB = parseVersion(versionB);
  if (!parsedA || !parsedB) {
    return null;
  }

  const coreLength = Math.max(parsedA.core.length, parsedB.core.length);
  for (let index = 0; index < coreLength; index++) {
    const segmentA = parsedA.core[index] ?? 0;
    const segmentB = parsedB.core[index] ?? 0;
    if (segmentA > segmentB) return 1;
    if (segmentA < segmentB) return -1;
  }

  // Cores are equal — a prerelease sorts below the corresponding release.
  if (parsedA.prerelease && !parsedB.prerelease) return -1;
  if (!parsedA.prerelease && parsedB.prerelease) return 1;
  if (parsedA.prerelease && parsedB.prerelease) {
    if (parsedA.prerelease < parsedB.prerelease) return -1;
    if (parsedA.prerelease > parsedB.prerelease) return 1;
  }
  return 0;
}

/**
 * True when `currentVersion` is strictly older than `minimumVersion`. Returns
 * `false` when either version is unparseable — fail-open, so a malformed flag
 * value never locks the user out of the app.
 */
export function isVersionBelowMinimum(currentVersion: string, minimumVersion: string): boolean {
  const comparison = compareVersions(currentVersion, minimumVersion);
  return comparison !== null && comparison < 0;
}
