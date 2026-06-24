import { describe, expect, it } from 'vitest';
import { workspaceRelativePosixPath } from '../workspace-relative-path';

describe('workspaceRelativePosixPath', () => {
  it('strips the workspace prefix for POSIX paths', () => {
    expect(
      workspaceRelativePosixPath(
        '/Users/curtis/Scratch/Webflow CMS',
        '/Users/curtis/Scratch/Webflow CMS/Airtable/Table 1',
      ),
    ).toBe('Airtable/Table 1');
  });

  it('strips the workspace prefix for native Windows backslash paths', () => {
    // Regression: on Windows both paths arrive with `\` separators. The old
    // `slice(...).replace(/^\//, '')` idiom left a leading backslash, producing
    // a rooted `\Airtable\…` path that the CLI re-anchored to the drive root.
    expect(
      workspaceRelativePosixPath(
        'C:\\Users\\curti\\Scratch\\Webflow CMS-SEO Demo',
        'C:\\Users\\curti\\Scratch\\Webflow CMS-SEO Demo\\Airtable\\Kittens Test 2025-03-25\\Table 1',
      ),
    ).toBe('Airtable/Kittens Test 2025-03-25/Table 1');
  });

  it('handles a Windows workspace with a forward-slash folder path', () => {
    expect(
      workspaceRelativePosixPath('C:\\Users\\curti\\Scratch\\Demo', 'C:/Users/curti/Scratch/Demo/Airtable/Table 1'),
    ).toBe('Airtable/Table 1');
  });

  it('returns empty string when the path is the workspace root', () => {
    expect(workspaceRelativePosixPath('C:\\Users\\curti\\Scratch\\Demo', 'C:\\Users\\curti\\Scratch\\Demo')).toBe('');
  });

  it('tolerates a trailing separator on either input', () => {
    expect(
      workspaceRelativePosixPath(
        'C:\\Users\\curti\\Scratch\\Demo\\',
        'C:\\Users\\curti\\Scratch\\Demo\\Airtable\\Table 1\\',
      ),
    ).toBe('Airtable/Table 1');
  });

  it('never emits a rooted path when the target is outside the workspace', () => {
    const result = workspaceRelativePosixPath('C:\\Users\\curti\\Scratch\\Demo', '\\Airtable\\Table 1');
    expect(result.startsWith('/')).toBe(false);
    expect(result).toBe('Airtable/Table 1');
  });
});
