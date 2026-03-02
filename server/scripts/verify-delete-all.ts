import { exec } from 'child_process';
import { randomUUID } from 'crypto';
import { promisify } from 'util';
import { ScratchGitClient } from '../src/scratch-git/scratch-git.client';
import { ScratchGitService } from '../src/scratch-git/scratch-git.service';

const execAsync = promisify(exec);

async function main() {
  console.log('Starting Delete All Records verification...');

  // We need a real git repo to test this properly, or mock the git client.
  // Since ScratchGitClient maps to local fs, we can test it with a temp repo.

  const workbookId = `wkb_verification-delete-all-${randomUUID()}` as any;
  const userId = 'user-1';
  const folderName = 'verification-data';

  // Real or Mock?
  // Use real file system interactions via ScratchGitClient

  const config = {
    getScratchGitApiUrl: () => 'http://localhost:3100',
  } as any;

  const client = new ScratchGitClient(config);
  const service = new ScratchGitService(client, null as any);

  console.log(`Initializing repo for ${workbookId}...`);
  await service.initRepo(workbookId);

  try {
    // 2. Create some files
    const files = [
      { path: `${folderName}/record1.json`, content: '{"id": 1}' },
      { path: `${folderName}/record2.json`, content: '{"id": 2}' },
      { path: `${folderName}/.schema.json`, content: '{"type": "object"}' }, // Should NOT be deleted
      { path: `other-folder/record3.json`, content: '{"id": 3}' }, // Should NOT be deleted
    ];

    console.log('Creating files...');
    await service.commitFilesToBranch(workbookId, 'main', files, 'Initial commit');

    // Switch to dirty branch implicitly by committing to it or just using working dir?
    // deleteAllFilesInDataFolder uses DIRTY_BRANCH.
    // So we need to ensure files exist on dirty branch or main is merged to dirty.
    // Ideally we rebase dirty on main first.
    await service.rebaseDirty(workbookId);

    // 3. Verify files exist
    const initialFiles = await service.listRepoFiles(workbookId, 'dirty', folderName);
    console.log(
      `Initial files in ${folderName}:`,
      initialFiles.map((f) => f.name),
    );

    if (initialFiles.length < 2) {
      throw new Error('Failed to create initial files');
    }

    // 4. Run Delete All
    console.log('Running deleteAllFilesInDataFolder...');
    await service.deleteAllFilesInDataFolder(workbookId, folderName);

    // 5. Verify results
    const finalFiles = await service.listRepoFiles(workbookId, 'dirty', folderName);
    console.log(
      `Final files in ${folderName}:`,
      finalFiles.map((f) => f.name),
    );

    if (finalFiles.length > 0) {
      throw new Error(`Failed to delete all records! Remaining: ${finalFiles.map((f) => f.name).join(', ')}`);
    }

    console.log('SUCCESS: All records deleted.');
  } catch (error) {
    console.error('Verification FAILED:', error);
    process.exit(1);
  } finally {
    // Cleanup
    console.log('Cleaning up...');
    await service.deleteRepo(workbookId);
  }
}

main();
