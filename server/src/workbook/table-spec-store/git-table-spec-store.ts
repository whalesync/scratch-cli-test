import type { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { ScratchGitService } from 'src/scratch-git/scratch-git.service';
import type { TableSpecLocation, TableSpecStore } from './table-spec-store';

/** The classic table spec store: the spec file in the folder's connection git repo. */
export class GitTableSpecStore implements TableSpecStore {
  constructor(private readonly scratchGitService: ScratchGitService) {}

  async readTableSpec(location: TableSpecLocation): Promise<BaseJsonTableSpec | null> {
    const repoId = await this.scratchGitService.resolveConnectionRepoPath(location.connectorAccountId);
    return this.scratchGitService.readSchemaFromGit(repoId, location.folderPath);
  }
}
