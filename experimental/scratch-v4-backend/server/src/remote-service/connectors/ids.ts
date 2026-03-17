/** The IDs we work on internally are used direclty in postgres and the UI and should be sane. */
// TODO(ryder): This doesn't check for uniqueness, so it will fail if two columns canonicalize to the same thing.
export function sanitizeForTableWsId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
}
