import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type {
  CreateScheduleDto,
  Schedule,
  UpdateScheduleDto,
  ValidatedCreateScheduleDto,
  WorkbookId,
} from '@spinner/shared-types';
import { ScheduleAction } from '@spinner/shared-types';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { ApiRateLimitGuard } from 'src/rate-limiter/api-rate-limit.guard';
import { userToActor } from 'src/users/types';
import { WorkbookService } from 'src/workbook/workbook.service';
import { ScheduleService } from './schedule.service';

@Controller('workbooks/:workbookId/schedules')
@UseGuards(ScratchAuthGuard, ApiRateLimitGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class ScheduleController {
  constructor(
    private readonly scheduleService: ScheduleService,
    private readonly workbookService: WorkbookService,
  ) {}

  @Post()
  async create(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() dto: CreateScheduleDto,
    @Req() req: RequestWithUser,
  ): Promise<Schedule> {
    const actor = userToActor(req.user);
    await this.workbookService.assertWritableWorkbook(actor, workbookId);
    return this.scheduleService.create(workbookId, dto as ValidatedCreateScheduleDto, actor);
  }

  @Get()
  async list(@Param('workbookId') workbookId: WorkbookId, @Req() req: RequestWithUser): Promise<Schedule[]> {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId);
    return this.scheduleService.findAllForWorkbook(workbookId);
  }

  @Get('by-entity')
  async findByEntity(
    @Param('workbookId') workbookId: WorkbookId,
    @Query('action') action: ScheduleAction,
    @Query('entityId') entityId: string,
    @Req() req: RequestWithUser,
  ): Promise<Schedule | null> {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId);
    return this.scheduleService.findByEntity(workbookId, action, entityId);
  }

  @Get(':scheduleId')
  async findOne(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('scheduleId') scheduleId: string,
    @Req() req: RequestWithUser,
  ): Promise<Schedule> {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId);
    return this.scheduleService.findOne(workbookId, scheduleId);
  }

  @Patch(':scheduleId')
  async update(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('scheduleId') scheduleId: string,
    @Body() dto: UpdateScheduleDto,
    @Req() req: RequestWithUser,
  ): Promise<Schedule> {
    const actor = userToActor(req.user);
    await this.workbookService.assertWritableWorkbook(actor, workbookId);
    return this.scheduleService.update(workbookId, scheduleId, dto);
  }

  @Delete(':scheduleId')
  async delete(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('scheduleId') scheduleId: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    const actor = userToActor(req.user);
    await this.workbookService.assertWritableWorkbook(actor, workbookId);
    return this.scheduleService.delete(workbookId, scheduleId);
  }
}
