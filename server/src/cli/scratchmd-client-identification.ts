/**
 * Tells which `scratchmd` build sent a `/cli/v1` request, from its User-Agent (DEV-13025).
 *
 * Until DEV-13025, every `scratchmd` binary sent the constant `Scratch-cli/1.0`, so the server couldn't tell versions
 * apart. Builds from DEV-13025 on send `Scratch-cli/1.0 scratchmd/<crate version>`, plus ` scratch-desktop/<app
 * version>` when Scratch Desktop runs its bundled binary. They keep the `Scratch-cli/` prefix that `CliStrategy`
 * accepts. So a request whose User-Agent is exactly the legacy constant comes from a binary that still copies table
 * specs from git, and the table-spec git mirror (DEV-13027) can't be turned off while those requests continue.
 */

/** The User-Agent every `scratchmd` binary sent before DEV-13025. */
export const LEGACY_SCRATCHMD_USER_AGENT = 'Scratch-cli/1.0';

/**
 * - `legacy-scratchmd`: exactly {@link LEGACY_SCRATCHMD_USER_AGENT}, a binary from before DEV-13025.
 * - `scratchmd`: a versioned `scratchmd/<version>` build.
 * - `other`: anything else, e.g. a browser, the Desktop renderer, or Bruno (`Scratch-cli/1.0 bruno`).
 */
export type ScratchmdClientKind = 'legacy-scratchmd' | 'scratchmd' | 'other';

export interface ScratchmdClientIdentification {
  scratchmdClientKind: ScratchmdClientKind;
  /** The `scratchmd/<version>` token's version, when there is one. */
  scratchmdVersion?: string;
  /** The `scratch-desktop/<version>` token's version, when there is one (the bundled binary or the renderer). */
  scratchDesktopVersion?: string;
}

/** A version token's value: a semver-like string, bounded so a hostile User-Agent can't flood analytics. */
const USER_AGENT_VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/;

export function classifyScratchmdClientFromUserAgent(userAgent: string | undefined): ScratchmdClientIdentification {
  if (userAgent === LEGACY_SCRATCHMD_USER_AGENT) return { scratchmdClientKind: 'legacy-scratchmd' };

  const userAgentTokens = (userAgent ?? '').split(/\s+/);
  const scratchmdVersion = findVersionOfUserAgentProduct(userAgentTokens, 'scratchmd');
  const scratchDesktopVersion = findVersionOfUserAgentProduct(userAgentTokens, 'scratch-desktop');
  return {
    scratchmdClientKind: scratchmdVersion ? 'scratchmd' : 'other',
    ...(scratchmdVersion && { scratchmdVersion }),
    ...(scratchDesktopVersion && { scratchDesktopVersion }),
  };
}

/** The version in the first `<productName>/<version>` token (product name case-insensitive), if it's well formed. */
function findVersionOfUserAgentProduct(userAgentTokens: string[], productName: string): string | undefined {
  const productPrefix = `${productName}/`;
  for (const userAgentToken of userAgentTokens) {
    if (userAgentToken.toLowerCase().startsWith(productPrefix)) {
      const productVersion = userAgentToken.slice(productPrefix.length);
      return USER_AGENT_VERSION_PATTERN.test(productVersion) ? productVersion : undefined;
    }
  }
  return undefined;
}
