import { PrismaClient } from '@prisma/client';
import type { DataFolderId } from '@spinner/shared-types';
import { FolderMovePathRewriteInput } from '../webflow-folder-restructure-backfill';
import { applyWebflowFolderMovePathRewrite } from '../webflow-folder-restructure-path-rewrite';

// The raw boundary-prefix SQL is validated against a real Postgres in
// test/integration/webflow-folder-restructure-db.spec.ts. This unit test pins the
// one thing that integration test can't easily assert about the *shipped* call:
// the interactive-transaction timeout.
describe('applyWebflowFolderMovePathRewrite', () => {
  // Regression for DEV-9698: a real Webflow collection with ~875k FileReference
  // rows took ~81s for the rewrite UPDATE and blew past Prisma's default 5s
  // interactive-transaction timeout, so the largest collections errored (and
  // cleanly rolled back). The per-folder rewrite must run with a much larger
  // timeout so big collections commit atomically instead of aborting.
  it("runs the rewrite in a transaction with a timeout far above Prisma's 5s default", async () => {
    let capturedOptions: { timeout?: number; maxWait?: number } | undefined;
    const txStub = {
      dataFolder: { update: jest.fn().mockResolvedValue(undefined) },
      fileIndex: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      syncTablePair: { findMany: jest.fn().mockResolvedValue([]) },
      recreatedIdMap: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      $executeRaw: jest.fn().mockResolvedValue(0),
    };
    const prisma = {
      $transaction: jest
        .fn()
        .mockImplementation(
          async (cb: (tx: typeof txStub) => Promise<unknown>, options: { timeout?: number; maxWait?: number }) => {
            capturedOptions = options;
            return cb(txStub);
          },
        ),
    } as unknown as PrismaClient;

    const input: FolderMovePathRewriteInput = {
      folderId: 'dfd_x' as DataFolderId,
      workbookId: 'wkb_x',
      connectorAccountId: 'coa_x',
      oldFolderPath: '/My Site/Blog Posts',
      newFolderPath: '/My Site/Collections/Blog Posts',
    };

    await applyWebflowFolderMovePathRewrite(prisma, input, 2);

    // Prisma's default is 5_000ms; the fix must raise it well above that.
    expect(capturedOptions?.timeout).toBeGreaterThanOrEqual(60_000);
    // Sanity: the rewrite ran inside the transaction.
    expect(txStub.dataFolder.update).toHaveBeenCalledTimes(1);
  });
});
