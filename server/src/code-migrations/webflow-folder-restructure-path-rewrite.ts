/**
 * DEV-9698 (T2) — the atomic, multi-column path rewrite at the heart of the
 * Webflow folder-restructure migration, extracted from
 * [CodeMigrationsController](./code-migrations.controller.ts) so it can be
 * exercised directly against a real Postgres in an integration test
 * (`server/test/integration/webflow-folder-restructure-db.spec.ts`). The
 * controller wires this in via `WebflowFolderRestructureDeps.applyFolderMovePathRewrite`.
 *
 * The boundary-prefix `UPDATE`s here are raw SQL, so a Jest-mocked `$transaction`
 * cannot validate them — only a real database can. Keeping the rewrite in one
 * exported function (rather than inline on the controller) is what lets that
 * integration test run the *actual* SQL the migration ships, not a copy that
 * could silently drift from it.
 */

import { PrismaClient } from '@prisma/client';
import { WEBFLOW_NESTED_STRUCTURE_VERSION } from 'src/remote-service/connectors/library/webflow/webflow-folder-paths';
import { FolderMovePathRewriteInput } from './webflow-folder-restructure-backfill';

/**
 * Apply, in ONE atomic Postgres transaction, the full path rewrite for a folder
 * move from `oldFolderPath` to `newFolderPath` (both leading-slash):
 *   - `DataFolder.path` := new, `DataFolder.version` := 2 (the idempotency commit point)
 *   - `FileIndex.folderPath`: exact match (no leading slash; records are direct children)
 *   - `FileReference.sourceFilePath`: boundary-prefix rewrite, all branches
 *   - `SyncMatchKeys.filePath`: boundary-prefix rewrite, scoped by `dataFolderId` = this folder
 *     (both source- and destination-side match keys live in their own dataFolder)
 *   - `SyncRemoteIdMapping.destinationFilePath`: destination side only, resolved via
 *     `SyncTablePair.destinationDataFolderId` (these rows are keyed by the SOURCE folder id, #9)
 *   - `RecreatedIdMap.folder`: exact folder-path match, scoped by (workbook, account)
 *   - `UploadPatchMeta.filePath`: boundary-prefix rewrite, scoped by (workbook, account)
 *
 * **Slash convention (critical):** `DataFolder.path` is the ONLY column that
 * stores a leading slash; every record/file path column stores paths relative
 * to the connection root with **no leading slash** (`My Site/Blog Posts/rec.json`),
 * the system-wide convention enforced by `validateRecordPath` (UploadPatchMeta),
 * `getAllFileContentsByFolderId`/sync's `path.replace(/^\//, '')` (SyncMatchKeys,
 * SyncRemoteIdMapping.destinationFilePath), `deleteForFolder(…, folderPathNoSlash)`
 * (FileReference), and `parsePath(filePath).folderPath` (RecreatedIdMap.folder).
 * So FileIndex AND all five file-path columns match on the no-leading-slash form;
 * only `DataFolder.path` keeps the slash. (The git `move_folder` route normalizes
 * the slash away itself, so it takes the leading-slash form.)
 *
 * The boundary-prefix rewrites match on `left(col, char_length(old)+1) = old || '/'`
 * (prefix-safe by construction — moving `Site/Blog` never touches `Site/Blog Posts` —
 * and multibyte-safe because Postgres counts characters itself), then swap the folder
 * prefix while preserving the filename via `substring`. `move_folder` refuses a folder
 * containing a nested data folder, so every record is a direct child and a single
 * prefix swap is sufficient. Mirrors `rewriteFilePathFolderPrefix` (the unit-tested twin).
 */
export async function applyWebflowFolderMovePathRewrite(
  prisma: PrismaClient,
  input: FolderMovePathRewriteInput,
): Promise<void> {
  const { folderId, workbookId, connectorAccountId, oldFolderPath, newFolderPath } = input;
  // Every column below except DataFolder.path stores the no-leading-slash form.
  const oldFolderPathNoLeadingSlash = oldFolderPath.replace(/^\//, '');
  const newFolderPathNoLeadingSlash = newFolderPath.replace(/^\//, '');

  await prisma.$transaction(async (tx) => {
    // DataFolder.path is the one leading-slash column. Also the idempotency commit point.
    await tx.dataFolder.update({
      where: { id: folderId },
      data: { path: newFolderPath, version: WEBFLOW_NESTED_STRUCTURE_VERSION },
    });

    // FileIndex.folderPath (no leading slash) equals the folder path exactly
    // (records are direct children) → exact-match updateMany.
    await tx.fileIndex.updateMany({
      where: { workbookId, folderPath: oldFolderPathNoLeadingSlash },
      data: { folderPath: newFolderPathNoLeadingSlash },
    });

    // FileReference.sourceFilePath (no leading slash): full file paths under the
    // folder, on every branch (main + dirty). Boundary-prefix rewrite.
    await tx.$executeRaw`
      UPDATE "FileReference"
      SET "sourceFilePath" = ${newFolderPathNoLeadingSlash} || substring("sourceFilePath" FROM char_length(${oldFolderPathNoLeadingSlash}) + 1)
      WHERE "workbookId" = ${workbookId}
        AND left("sourceFilePath", char_length(${oldFolderPathNoLeadingSlash}) + 1) = ${oldFolderPathNoLeadingSlash} || '/'
    `;

    // SyncMatchKeys.filePath (no leading slash): keyed by dataFolderId; a match
    // key's filePath always lives in its own dataFolder, so filtering on this
    // folder id catches both the source-side and destination-side keys.
    await tx.$executeRaw`
      UPDATE "SyncMatchKeys"
      SET "filePath" = ${newFolderPathNoLeadingSlash} || substring("filePath" FROM char_length(${oldFolderPathNoLeadingSlash}) + 1)
      WHERE "dataFolderId" = ${folderId}
        AND left("filePath", char_length(${oldFolderPathNoLeadingSlash}) + 1) = ${oldFolderPathNoLeadingSlash} || '/'
    `;

    // SyncRemoteIdMapping.destinationFilePath (no leading slash) points into the
    // DESTINATION folder but its row is keyed by the SOURCE folder id (finding #9).
    // So when THIS folder is a sync destination, resolve the affected rows via the
    // table pair's destinationDataFolderId → (syncId, sourceDataFolderId), then rewrite.
    const destinationPairs = await tx.syncTablePair.findMany({
      where: { destinationDataFolderId: folderId },
      select: { syncId: true, sourceDataFolderId: true },
    });
    for (const pair of destinationPairs) {
      await tx.$executeRaw`
        UPDATE "SyncRemoteIdMapping"
        SET "destinationFilePath" = ${newFolderPathNoLeadingSlash} || substring("destinationFilePath" FROM char_length(${oldFolderPathNoLeadingSlash}) + 1)
        WHERE "syncId" = ${pair.syncId}
          AND "dataFolderId" = ${pair.sourceDataFolderId}
          AND "destinationFilePath" IS NOT NULL
          AND left("destinationFilePath", char_length(${oldFolderPathNoLeadingSlash}) + 1) = ${oldFolderPathNoLeadingSlash} || '/'
      `;
    }

    // RecreatedIdMap.folder (no leading slash) is the folder path exactly (not a
    // file), scoped per (workbook, account) → exact-match updateMany.
    await tx.recreatedIdMap.updateMany({
      where: { workbookId, connectorAccountId, folder: oldFolderPathNoLeadingSlash },
      data: { folder: newFolderPathNoLeadingSlash },
    });

    // UploadPatchMeta.filePath (no leading slash): full file paths, scoped per (workbook, account).
    await tx.$executeRaw`
      UPDATE "UploadPatchMeta"
      SET "filePath" = ${newFolderPathNoLeadingSlash} || substring("filePath" FROM char_length(${oldFolderPathNoLeadingSlash}) + 1)
      WHERE "workbookId" = ${workbookId}
        AND "connectorAccountId" = ${connectorAccountId}
        AND left("filePath", char_length(${oldFolderPathNoLeadingSlash}) + 1) = ${oldFolderPathNoLeadingSlash} || '/'
    `;
  });
}
