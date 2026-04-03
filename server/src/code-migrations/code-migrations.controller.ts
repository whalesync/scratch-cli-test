import {
  BadRequestException,
  Body,
  ClassSerializerInterceptor,
  Controller,
  Get,
  Logger,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type {
  AvailableMigrationsResponse,
  MigrationResult,
  RunMigrationDto,
  ValidatedRunMigrationDto,
  WorkbookId,
} from '@spinner/shared-types';
import { hasAdminToolsPermission } from 'src/auth/permissions';
import { WorkbookRepoService } from 'src/workbook/workbook-repo.service';
import { ScratchAuthGuard } from '../auth/scratch-auth.guard';
import type { RequestWithUser } from '../auth/types';
import { DbService } from '../db/db.service';

const AVAILABLE_MIGRATIONS: string[] = ['init-workbook-repos'];

@Controller('code-migrations')
@UseGuards(ScratchAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class CodeMigrationsController {
  private readonly logger = new Logger(CodeMigrationsController.name);

  constructor(
    private readonly db: DbService,
    private readonly workbookRepoService: WorkbookRepoService,
  ) {}

  @Get('available')
  getAvailableMigrations(@Req() req: RequestWithUser): AvailableMigrationsResponse {
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can access migrations');
    }

    return { migrations: AVAILABLE_MIGRATIONS };
  }

  @Post('run')
  async runMigration(@Req() req: RequestWithUser, @Body() dtoParam: RunMigrationDto): Promise<MigrationResult> {
    const dto = dtoParam as ValidatedRunMigrationDto;
    if (!hasAdminToolsPermission(req.user)) {
      throw new UnauthorizedException('Only admins can run migrations');
    }

    // Validate that either qty or ids is provided, but not both
    if (dto.qty && dto.ids && dto.ids.length > 0) {
      throw new BadRequestException('Cannot provide both qty and ids. Choose one.');
    }

    if (!dto.qty && (!dto.ids || dto.ids.length === 0)) {
      throw new BadRequestException('Must provide either qty or ids.');
    }

    switch (dto.migration) {
      case 'init-workbook-repos':
        return this.initWorkbookRepos(dto);
      default:
        throw new BadRequestException(`Unknown migration: ${dto.migration}`);
    }
  }

  /**
   * Initialize workbook config repos for workbooks created before auto-init was added (2026-04-01).
   * Idempotent — safe to run multiple times; existing repos are skipped by scratch-git.
   */
  private async initWorkbookRepos(dto: ValidatedRunMigrationDto): Promise<MigrationResult> {
    let workbooks;

    if (dto.ids && dto.ids.length > 0) {
      workbooks = await this.db.client.workbook.findMany({
        where: { id: { in: dto.ids } },
        select: { id: true, organizationId: true },
      });
    } else {
      workbooks = await this.db.client.workbook.findMany({
        select: { id: true, organizationId: true },
        take: dto.qty,
        orderBy: { createdAt: 'asc' },
      });
    }

    const migratedIds: string[] = [];
    for (const wb of workbooks) {
      try {
        await this.workbookRepoService.initWorkbookRepo(wb.organizationId, wb.id as WorkbookId);
        migratedIds.push(wb.id);
      } catch (error) {
        this.logger.error(`Failed to init workbook repo for ${wb.id}: ${String(error)}`);
      }
    }

    const totalCount = await this.db.client.workbook.count();

    return {
      migratedIds,
      remainingCount: totalCount - migratedIds.length,
      migrationName: 'init-workbook-repos',
    };
  }
}
