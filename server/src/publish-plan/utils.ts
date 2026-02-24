/**
 * Parse a file path into its folder and filename components.
 *
 * @example parsePath('articles/my-post.json') => { folderPath: 'articles', filename: 'my-post.json' }
 * @example parsePath('file.json') => { folderPath: '', filename: 'file.json' }
 */
export function parsePath(filePath: string): { folderPath: string; filename: string } {
  const lastSlash = filePath.lastIndexOf('/');
  return {
    folderPath: lastSlash === -1 ? '' : filePath.substring(0, lastSlash),
    filename: filePath.substring(lastSlash + 1),
  };
}
