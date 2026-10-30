import { WorkbookId } from '@spinner/shared-types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import { Actor } from 'src/users/types';
import { RoutineDefinitionStoreService } from '../routine-definition-store.service';
import { RoutineGitMirrorService } from '../routine-git-mirror.service';

const WORKBOOK_ID = 'wkb_test1234' as WorkbookId;
const REPO_ID = 'org_test1234/wkb_test1234/wkb_test1234';
const ACTOR: Actor = { userId: 'usr_test1234', organizationId: 'org_test1234' };

function definition(filePath: string, content: string) {
  return { filePath, content };
}

describe('RoutineGitMirrorService', () => {
  let isRoutinesGitMirrorEnabled: jest.Mock;
  let commitFilesToBranch: jest.Mock;
  let deleteFilesFromBranch: jest.Mock;
  let getBranchHead: jest.Mock;
  let listDefinitions: jest.Mock;
  let readRoutineFilesFromGit: jest.Mock;
  let service: RoutineGitMirrorService;

  beforeEach(() => {
    isRoutinesGitMirrorEnabled = jest.fn().mockReturnValue(true);
    commitFilesToBranch = jest.fn().mockResolvedValue({ created: [], updated: [], unchanged: [] });
    deleteFilesFromBranch = jest.fn().mockResolvedValue(undefined);
    getBranchHead = jest.fn().mockResolvedValue('headsha123');
    listDefinitions = jest.fn().mockResolvedValue([]);
    readRoutineFilesFromGit = jest.fn().mockResolvedValue([]);

    service = new RoutineGitMirrorService(
      { isRoutinesGitMirrorEnabled } as unknown as ScratchConfigService,
      { commitFilesToBranch, deleteFilesFromBranch, getBranchHead } as unknown as ScratchGitService,
      {
        resolveConfigRepoId: jest.fn().mockResolvedValue(REPO_ID),
        listDefinitions,
        readRoutineFilesFromGit,
      } as unknown as RoutineDefinitionStoreService,
    );
  });

  it('does nothing — no git access, head null — when the mirror is disabled', async () => {
    isRoutinesGitMirrorEnabled.mockReturnValue(false);

    const head = await service.mirrorWorkbookRoutines(WORKBOOK_ID, ACTOR);

    expect(head).toBeNull();
    expect(listDefinitions).not.toHaveBeenCalled();
    expect(commitFilesToBranch).not.toHaveBeenCalled();
    expect(deleteFilesFromBranch).not.toHaveBeenCalled();
  });

  it('converges git to the DB: commits new + changed files, deletes files with no row, returns the head', async () => {
    listDefinitions.mockResolvedValue([
      definition('routines/same.yaml', 'name: Same\n'),
      definition('routines/changed.yaml', 'name: New content\n'),
      definition('routines/added.yaml', 'name: Added\n'),
    ]);
    readRoutineFilesFromGit.mockResolvedValue([
      { path: 'routines/same.yaml', content: 'name: Same\n' },
      { path: 'routines/changed.yaml', content: 'name: Old content\n' },
      { path: 'routines/deleted.yaml', content: 'name: Deleted in DB\n' },
    ]);

    const head = await service.mirrorWorkbookRoutines(WORKBOOK_ID, ACTOR);

    expect(commitFilesToBranch).toHaveBeenCalledWith(
      REPO_ID,
      'main',
      [
        { path: 'routines/changed.yaml', content: 'name: New content\n' },
        { path: 'routines/added.yaml', content: 'name: Added\n' },
      ],
      expect.stringContaining('Mirror routines'),
    );
    expect(deleteFilesFromBranch).toHaveBeenCalledWith(
      REPO_ID,
      'main',
      ['routines/deleted.yaml'],
      expect.stringContaining('Mirror routines'),
    );
    expect(head).toBe('headsha123');
  });

  it('makes no commit when git already matches the DB', async () => {
    listDefinitions.mockResolvedValue([definition('routines/a.yaml', 'name: A\n')]);
    readRoutineFilesFromGit.mockResolvedValue([{ path: 'routines/a.yaml', content: 'name: A\n' }]);

    const head = await service.mirrorWorkbookRoutines(WORKBOOK_ID, ACTOR);

    expect(commitFilesToBranch).not.toHaveBeenCalled();
    expect(deleteFilesFromBranch).not.toHaveBeenCalled();
    expect(head).toBe('headsha123');
  });

  it('mirrorWorkbookRoutinesInBackground swallows and logs a git failure', async () => {
    listDefinitions.mockResolvedValue([definition('routines/a.yaml', 'name: A\n')]);
    commitFilesToBranch.mockRejectedValue(new Error('git down'));

    expect(() => service.mirrorWorkbookRoutinesInBackground(WORKBOOK_ID, ACTOR)).not.toThrow();
    // Let the rejected promise settle inside the background wrapper.
    await new Promise((resolve) => setImmediate(resolve));
    expect(commitFilesToBranch).toHaveBeenCalledTimes(1);
  });

  it('mirrorWorkbookRoutines propagates a git failure (the caller decides what to do)', async () => {
    listDefinitions.mockResolvedValue([definition('routines/a.yaml', 'name: A\n')]);
    commitFilesToBranch.mockRejectedValue(new Error('git down'));

    await expect(service.mirrorWorkbookRoutines(WORKBOOK_ID, ACTOR)).rejects.toThrow('git down');
  });
});
