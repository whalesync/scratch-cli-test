import * as posixPath from 'path/posix';

const MAX_FILENAME_LENGTH = 80;

/**
 * @param filename - name of the file to slugify
 * @returns a version of the file name that is safe to use as a file name
 */
export function normalizeFileName(filename: string): string {
  const normalized = filename
    .toString() // Ensure the input is a string
    .normalize('NFD') // Split accented letters into base letter and accent
    .replace(/[\u0300-\u036f]/g, '') // Remove all previously split accents (diacritical marks)
    .toLowerCase() // Convert to lowercase
    .trim() // Trim leading/trailing whitespace
    .replace(/\s+/g, '-') // Replace spaces with hyphens
    .replace(/[^a-z0-9 -]/g, '') // Remove all non-alphanumeric characters, except hyphens and spaces
    .replace(/-+/g, '-'); // Replace multiple hyphens with a single hyphen

  if (normalized.length <= MAX_FILENAME_LENGTH) {
    return normalized;
  }

  return normalized.slice(0, MAX_FILENAME_LENGTH).replace(/-+$/, '');
}

/**
 * @param name - name of the folder to normalize
 * @returns a version of the folder name that is safe to use as a folder name in a path
 */
export function normalizeFolderName(name: string): string {
  return name.toString().replace(/\//g, ' ').replace(/\r/g, ' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Extract the filename from a POSIX path.
 * @param path - a POSIX-style file path (e.g. "/folder/subfolder/file.txt")
 * @returns the filename portion of the path (e.g. "file.txt")
 */
export function extractFilenameFromPath(path: string): string {
  return posixPath.basename(path);
}

/**
 * A normalized slug is "usable" iff it starts with an alphanumeric. This
 * rejects empty results (`normalizeFileName` returns `""` when the input is
 * all-punctuation or all non-ASCII), pure-punctuation results (e.g. `"-"`
 * from a CJK-then-ASCII slug source), and leading-dot/leading-hyphen results
 * that would produce POSIX hidden-file or shell-flag-like filenames once the
 * extension is appended (`.json`, `-alex.json`).
 *
 * Callers use this to decide whether to fall back to the record ID instead of
 * trusting the slug. Without it, a Stripe customer named `鄭菲菲` produces a
 * filename of `.json`, which the working-tree walker can't see and which
 * tools generally treat as hidden.
 */
export function isUsableFileNameSlug(slug: string): boolean {
  return /^[a-z0-9]/.test(slug);
}

/**
 * Make a record ID safe to use as a filename base.
 *
 * Record IDs can contain path separators and other characters that are unsafe in a
 * filename — most notably Shopify GIDs like `gid://shopify/ProductVariant/51423653331240`,
 * whose slashes would turn the "filename" into a nested directory path and cause the
 * record to be lost at commit time (the whole table then reads as empty, and the
 * stale-file cleanup deletes the mis-staged tree — DEV-11015).
 *
 * Every character outside `[A-Za-z0-9._-]` is replaced with `-`, runs of `-` are
 * collapsed, and any leading `-`/`.` is trimmed so the result can never become a
 * flag-like (`-x.json`) or hidden (`.json`) filename once the extension is appended.
 * Unlike {@link normalizeFileName} it deliberately preserves case and digits (it does
 * NOT lowercase or strip alphanumerics), so two distinct record IDs stay distinct —
 * this matters because the sanitized ID is also used as the collision-breaking suffix
 * in {@link deduplicateFileName}, where uniqueness is the whole point. Falls back to
 * `record` only for an empty/all-unsafe ID (a degenerate record with no usable id).
 */
export function sanitizeRecordIdForFileName(recordId: string): string {
  const safe = recordId
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+/, '');
  return safe.length > 0 ? safe : 'record';
}

/**
 * Resolves the preferred base filename (without extension) for a record.
 * Priority: slug value > title value > ID value.
 * Slug and title values are run through normalizeFileName for safety, then
 * checked by [`isUsableFileNameSlug`] — falls through to the next option (or
 * the record ID) when normalization produces an empty / leading-`.` / leading-
 * `-` result.
 */
export function resolveBaseFileName(options: {
  slugValue?: string | null;
  titleValue?: string | null;
  idValue: string;
}): string {
  if (options.slugValue && typeof options.slugValue === 'string' && options.slugValue.trim()) {
    const normalized = normalizeFileName(options.slugValue);
    if (isUsableFileNameSlug(normalized)) return normalized;
  }
  if (options.titleValue && typeof options.titleValue === 'string' && options.titleValue.trim()) {
    const normalized = normalizeFileName(options.titleValue);
    if (isUsableFileNameSlug(normalized)) return normalized;
  }
  return options.idValue;
}

/**
 * Ensures a filename is unique within a set of existing names.
 * If the candidate collides, appends the record's ID as a deterministic suffix.
 * Adds the final name to the usedFileNames set.
 */
export function deduplicateFileName(
  baseName: string,
  extension: string,
  usedFileNames: Set<string>,
  recordId: string,
): string {
  let candidate = baseName + extension;
  if (usedFileNames.has(candidate)) {
    candidate = `${baseName}-${recordId}${extension}`;
  }
  usedFileNames.add(candidate);
  return candidate;
}

export function assertFolderPathIsValid(path: unknown): asserts path is string {
  if (typeof path !== 'string') {
    throw new Error(`Path must be a string, but got ${typeof path}: ${path as string}`);
  }
  if (path.length === 0) {
    throw new Error('Path must not be empty');
  }
  if (!path.startsWith('/')) {
    throw new Error('Path must start with a slash');
  }
}
