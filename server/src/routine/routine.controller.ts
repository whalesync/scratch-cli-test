import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Routine, RoutineFileContent, RoutineRun, WorkbookId } from '@spinner/shared-types';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { ApiRateLimitGuard } from 'src/rate-limiter/api-rate-limit.guard';
import { userToActor } from 'src/users/types';
import { WorkbookService } from 'src/workbook/workbook.service';
import { CreateRoutineFileDto } from './dto/create-routine-file.dto';
import { RoutineRunGetQueryDto } from './dto/routine-run-get-query.dto';
import { RoutineRunListQueryDto } from './dto/routine-run-list-query.dto';
import { TriggerRoutineDto } from './dto/trigger-routine.dto';
import { UpdateRoutineFileDto } from './dto/update-routine-file.dto';
import { RoutineExecutorService } from './routine-executor.service';
import { RoutineService } from './routine.service';

@Controller('workbooks/:workbookId')
@UseGuards(ScratchAuthGuard, ApiRateLimitGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class RoutineController {
  constructor(
    private readonly routineService: RoutineService,
    private readonly routineExecutorService: RoutineExecutorService,
    private readonly workbookService: WorkbookService,
  ) {}

  /** Re-read routine files from git and sync their ROUTINE schedule rows. A write — asserts writable. */
  @Post('routines/reload')
  async reload(@Param('workbookId') workbookId: WorkbookId, @Req() req: RequestWithUser): Promise<Routine[]> {
    const actor = userToActor(req.user);
    await this.workbookService.assertWritableWorkbook(actor, workbookId);
    return this.routineService.reloadRoutines(workbookId, actor);
  }

  @Get('routines')
  async listRoutines(@Param('workbookId') workbookId: WorkbookId, @Req() req: RequestWithUser): Promise<Routine[]> {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId);
    return this.routineService.listRoutines(workbookId);
  }

  /** Read the raw YAML text of one routine file (for the editor). */
  @Get('routines/file')
  async getRoutineFile(
    @Param('workbookId') workbookId: WorkbookId,
    @Query('path') path: string,
    @Req() req: RequestWithUser,
  ): Promise<RoutineFileContent> {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId);
    return this.routineService.getRoutineFileContent(workbookId, path);
  }

  /** Create a new routine YAML file. Rejects a duplicate path (409) or invalid YAML (400). */
  @Post('routines/file')
  async createRoutineFile(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() dto: CreateRoutineFileDto,
    @Req() req: RequestWithUser,
  ): Promise<Routine> {
    const actor = userToActor(req.user);
    await this.workbookService.assertWritableWorkbook(actor, workbookId);
    return this.routineService.createRoutineFile(workbookId, dto, actor);
  }

  /** Replace an existing routine file's content. Rejects a missing file (404) or invalid YAML (400). */
  @Put('routines/file')
  async updateRoutineFile(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() dto: UpdateRoutineFileDto,
    @Req() req: RequestWithUser,
  ): Promise<Routine> {
    const actor = userToActor(req.user);
    await this.workbookService.assertWritableWorkbook(actor, workbookId);
    return this.routineService.updateRoutineFile(workbookId, dto, actor);
  }

  /** Delete a routine YAML file (and its ROUTINE schedule, if any). */
  @Delete('routines/file')
  @HttpCode(204)
  async deleteRoutineFile(
    @Param('workbookId') workbookId: WorkbookId,
    @Query('path') path: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    const actor = userToActor(req.user);
    await this.workbookService.assertWritableWorkbook(actor, workbookId);
    await this.routineService.deleteRoutineFile(workbookId, path, actor);
  }

  /** Start a manual run of one routine. 409 if the routine already has an active run. A write — asserts writable. */
  @Post('routines/trigger')
  async trigger(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() dto: TriggerRoutineDto,
    @Req() req: RequestWithUser,
  ): Promise<RoutineRun> {
    const actor = userToActor(req.user);
    await this.workbookService.assertWritableWorkbook(actor, workbookId);
    return this.routineExecutorService.triggerRun(workbookId, dto.filePath, 'manual', actor);
  }

  @Get('routine-runs')
  async listRuns(
    @Param('workbookId') workbookId: WorkbookId,
    @Query() query: RoutineRunListQueryDto,
    @Req() req: RequestWithUser,
  ): Promise<RoutineRun[]> {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId);
    return this.routineService.listRuns(workbookId, query);
  }

  @Get('routine-runs/:runId')
  async getRun(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('runId') runId: string,
    @Query() query: RoutineRunGetQueryDto,
    @Req() req: RequestWithUser,
  ): Promise<RoutineRun> {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId);
    return this.routineService.getRun(workbookId, runId, query.includeJobs);
  }

  /** Cancel a running routine run (stops its in-flight step's job). A write — asserts writable. */
  @Post('routine-runs/:runId/cancel')
  async cancelRun(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('runId') runId: string,
    @Req() req: RequestWithUser,
  ): Promise<RoutineRun> {
    const actor = userToActor(req.user);
    await this.workbookService.assertWritableWorkbook(actor, workbookId);
    return this.routineExecutorService.cancelRun(workbookId, runId, actor);
  }
}
