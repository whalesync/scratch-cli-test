import {
  ClassSerializerInterceptor,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Routine, RoutineRun, WorkbookId } from '@spinner/shared-types';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { ApiRateLimitGuard } from 'src/rate-limiter/api-rate-limit.guard';
import { userToActor } from 'src/users/types';
import { WorkbookService } from 'src/workbook/workbook.service';
import { RoutineRunListQueryDto } from './dto/routine-run-list-query.dto';
import { RoutineService } from './routine.service';

@Controller('workbooks/:workbookId')
@UseGuards(ScratchAuthGuard, ApiRateLimitGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class RoutineController {
  constructor(
    private readonly routineService: RoutineService,
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
    @Req() req: RequestWithUser,
  ): Promise<RoutineRun> {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId);
    return this.routineService.getRun(workbookId, runId);
  }
}
