/**
 * Escape a single JSON Pointer reference token per RFC 6901 §3.
 *
 * Required when interpolating arbitrary (e.g. user-controlled) keys into a
 * pointer path: `~` must be encoded as `~0` and `/` as `~1`, otherwise the
 * pointer walks the wrong sub-tree. Encode `~` first so the `~1` produced
 * from `/` is not re-encoded.
 *
 * https://datatracker.ietf.org/doc/html/rfc6901#section-3
 */
export function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}
