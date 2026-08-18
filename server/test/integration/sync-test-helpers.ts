/**
 * Test doubles shared by the sync integration specs.
 */

import { PrismaClient } from '@prisma/client';
import type { DataFolderId, WorkbookId } from '@spinner/shared-types';
import { ScratchGitNotFoundError } from 'src/scratch-git/scratch-git.client';
import type { Actor } from 'src/users/types';
import type { DataFolderService } from 'src/workbook/data-folder.service';

/**
 * Builds a `ScratchGitService.readRepoFilesByFolder` double that resolves paths
 * against the SAME in-memory folder contents the mocked paginated reader serves.
 *
 * Sync's Pass 2 reads each page's matched destination records through this call
 * rather than holding a map of the whole destination folder (DEV-11194). Backing
 * the double with its own fixture would let the two readers drift apart and hide
 * exactly the class of bug a per-page read can introduce, so it pages through the
 * paginated mock itself and indexes what comes back.
 *
 * Both fallbacks mirror the real git service, whose `files-from-folder` route walks
 * the tree with `read_tree_at_path_or_empty`: a path that isn't in the tree comes
 * back as `content: null`, and a folder with no tree at all reads as empty rather
 * than 404ing.
 */
export function createReadRepoFilesByFolderMock(options: {
  prisma: PrismaClient;
  dataFolderService: DataFolderService;
  getWorkbookId: () => WorkbookId;
  getActor: () => Actor;
}): jest.Mock {
  const { prisma, dataFolderService, getWorkbookId, getActor } = options;

  return jest.fn(async (_repoId: string, branch: string, paths: string[]) => {
    const workbookId = getWorkbookId();
    const foldersInWorkbook = await prisma.dataFolder.findMany({ where: { workbookId } });

    const contentByPath = new Map<string, string>();
    for (const folder of foldersInWorkbook) {
      let cursor: string | undefined;
      do {
        let page: { files: Array<{ path: string; content: string }>; nextCursor?: string };
        try {
          page = (await (dataFolderService.getFileContentsByFolderIdPaginated as jest.Mock)(
            workbookId,
            folder.id as DataFolderId,
            getActor(),
            branch,
            cursor,
          )) as { files: Array<{ path: string; content: string }>; nextCursor?: string };
        } catch (error) {
          if (error instanceof ScratchGitNotFoundError) {
            break;
          }
          throw error;
        }
        for (const file of page.files) {
          contentByPath.set(file.path, file.content);
        }
        cursor = page.nextCursor;
      } while (cursor);
    }

    return paths.map((path) => ({ path, content: contentByPath.get(path) ?? null }));
  });
}
