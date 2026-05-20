const MAX_DEEP_LINK_SOURCE_LENGTH = 20;

export function sanitizeDeepLinkSource(source: string | null | undefined): string | undefined {
  const trimmed = source?.trim();
  if (!trimmed) {
    return undefined;
  }

  const sanitized = trimmed
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_DEEP_LINK_SOURCE_LENGTH);

  return sanitized || undefined;
}
