import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as path from 'path';
import { WorkbookService } from './workbook.service';

/**
 * Minimal workbook endpoint consumed by `scratchmd pull`.
 * Mounted at GET /experimental/workbooks/:workbookId
 */
@Controller('workbooks')
export class WorkbookController {
  constructor(
    private readonly workbookService: WorkbookService,
    private readonly config: ConfigService,
  ) {}

  @Get(':workbookId')
  async getWorkbook(@Param('workbookId') workbookId: string) {
    const workbook = await this.workbookService.findById(workbookId);
    if (!workbook) {
      throw new NotFoundException(`Workbook ${workbookId} not found`);
    }
    const reposDir = this.config.getOrThrow('GIT_REPOS_DIR');
    return {
      id: workbook.id,
      name: workbook.name,
      workbookRepoPath: path.relative(reposDir, workbook.workbookRepoPath),
      connectorAccounts: workbook.connectorAccounts.map((c) => ({
        id: c.id,
        name: c.name,
        repoPath: path.relative(reposDir, c.repoPath),
      })),
    };
  }
}
