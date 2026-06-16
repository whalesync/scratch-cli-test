import { PathValidationError, validateRecordPath } from '../path-validation';

const folders = [{ path: '/Companies' }, { path: '/Posts' }];

describe('validateRecordPath', () => {
  it('accepts a path inside a known DataFolder and normalizes separators', () => {
    expect(validateRecordPath('Companies/rec1.json', folders)).toBe('Companies/rec1.json');
    expect(validateRecordPath('Companies\\rec1.json', folders)).toBe('Companies/rec1.json');
    expect(validateRecordPath('Companies//rec1.json', folders)).toBe('Companies/rec1.json');
    expect(validateRecordPath('Companies/rec1.json/', folders)).toBe('Companies/rec1.json');
  });

  it('rejects empty paths', () => {
    expectError('empty', () => validateRecordPath('', folders));
  });

  it('rejects absolute paths', () => {
    expectError('absolute', () => validateRecordPath('/Companies/rec1.json', folders));
  });

  it('rejects path traversal segments', () => {
    expectError('traversal', () => validateRecordPath('Companies/../etc/passwd', folders));
    expectError('traversal', () => validateRecordPath('../Companies/rec1.json', folders));
    expectError('traversal', () => validateRecordPath('Companies/./rec1.json', folders));
  });

  it('rejects reserved prefixes', () => {
    expectError('reserved', () => validateRecordPath('.git/config', folders));
    expectError('reserved', () => validateRecordPath('.scratch/conflicts.log', folders));
  });

  it('rejects paths outside any known DataFolder', () => {
    expectError('outside-data-folder', () => validateRecordPath('Other/rec1.json', folders));
  });

  it('rejects a path that equals a DataFolder (no slash, just the folder name)', () => {
    // The check that catches this is `outside-data-folder` — `Companies` does
    // not match the `${folder}/` prefix that requires a file inside the folder.
    expectError('outside-data-folder', () => validateRecordPath('Companies', folders));
  });

  it('gives an actionable outside-data-folder message that names the stale-clone cause + the re-clone recovery (T5)', () => {
    // A stale local clone whose folder layout predates a server-side restructure
    // (DEV-9698) uploads paths the server no longer knows. The reject must point
    // the user at the fix rather than just stating the path is unknown.
    try {
      validateRecordPath('Old Site/Blog/rec1.json', folders);
    } catch (err) {
      expect(err).toBeInstanceOf(PathValidationError);
      const message = (err as PathValidationError).message;
      // Stable prefix (tests/callers key off the code, but the leading phrasing
      // is preserved) + the offending path.
      expect(message).toContain('Path is not inside any known DataFolder');
      expect(message).toContain('Old Site/Blog/rec1.json');
      // Actionable cause + recovery.
      expect(message).toContain('folder structure changed on the server');
      expect(message).toContain('workspaces init');
      expect(message).toContain('--force');
      return;
    }
    throw new Error('Expected PathValidationError but none was thrown');
  });

  it('skips inside-folder check when dataFolders is empty', () => {
    expect(validateRecordPath('Anything/rec1.json', [])).toBe('Anything/rec1.json');
  });

  it('tolerates trailing slashes on DataFolder.path', () => {
    expect(validateRecordPath('Companies/rec1.json', [{ path: '/Companies/' }])).toBe('Companies/rec1.json');
  });
});

function expectError(code: string, fn: () => unknown) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PathValidationError);
    expect((err as PathValidationError).code).toBe(code);
    return;
  }
  throw new Error(`Expected PathValidationError(${code}) but no error was thrown`);
}
