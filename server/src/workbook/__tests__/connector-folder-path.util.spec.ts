import { sanitizeConnectionFolderName, sanitizeLegacyConnectionFolderName } from '../connector-folder-path.util';

// These must stay in parity with the Rust CLI's `sanitize_filename` /
// `connector_dir_name` / `connector_dir_name_legacy`
// (scratch-git-2/src/cli/config/markers.rs) — the connection folder name is what
// actually names the top-level folder on disk, and the publish resolver matches a
// pseudo-ref's connection segment against these. See markers.rs test module.
describe('sanitizeConnectionFolderName', () => {
  it('leaves an ordinary display name unchanged', () => {
    expect(sanitizeConnectionFolderName('My Base')).toBe('My Base');
    expect(sanitizeConnectionFolderName('HubSpot')).toBe('HubSpot');
    expect(sanitizeConnectionFolderName('HubSpot Testing')).toBe('HubSpot Testing');
  });

  it('replaces filesystem-reserved characters with a hyphen', () => {
    // Mirrors Rust `connector_dir_name_sanitizes_special_chars`.
    expect(sanitizeConnectionFolderName('foo/bar:baz')).toBe('foo-bar-baz');
    expect(sanitizeConnectionFolderName('a\\b*c?d"e<f>g|h')).toBe('a-b-c-d-e-f-g-h');
  });
});

describe('sanitizeLegacyConnectionFolderName', () => {
  it('prefixes the service and sanitizes', () => {
    // Mirrors Rust `connector_dir_name_legacy_prefixes_service`.
    expect(sanitizeLegacyConnectionFolderName('Airtable', 'My Base')).toBe('Airtable - My Base');
    // Mirrors Rust `connector_dir_name_legacy_sanitizes_special_chars`.
    expect(sanitizeLegacyConnectionFolderName('Air/table', 'My:Base')).toBe('Air-table - My-Base');
  });
});
