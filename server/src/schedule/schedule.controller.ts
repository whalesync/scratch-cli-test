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
import { userToActor } from 'src/users/types';
import { ScheduleService } from './schedule.service';

@Controller('workbooks/:workbookId/schedules')
@UseGuards(ScratchAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class ScheduleController {
  constructor(private readonly scheduleService: ScheduleService) {}

  @Post()
  async create(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() dto: CreateScheduleDto,
    @Req() req: RequestWithUser,
  ): Promise<Schedule> {
    return this.scheduleService.create(workbookId, dto as ValidatedCreateScheduleDto, userToActor(req.user));
  }

  @Get()
  async list(@Param('workbookId') workbookId: WorkbookId, @Req() req: RequestWithUser): Promise<Schedule[]> {
    return this.scheduleService.findAllForWorkbook(workbookId, userToActor(req.user));
  }

  @Get('by-entity')
  async findByEntity(
    @Param('workbookId') workbookId: WorkbookId,
    @Query('action') action: ScheduleAction,
    @Query('entityId') entityId: string,
    @Req() req: RequestWithUser,
  ): Promise<Schedule | null> {
    return this.scheduleService.findByEntity(workbookId, action, entityId, userToActor(req.user));
  }

  @Get(':scheduleId')
  async findOne(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('scheduleId') scheduleId: string,
    @Req() req: RequestWithUser,
  ): Promise<Schedule> {
    return this.scheduleService.findOne(workbookId, scheduleId, userToActor(req.user));
  }

  @Patch(':scheduleId')
  async update(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('scheduleId') scheduleId: string,
    @Body() dto: UpdateScheduleDto,
    @Req() req: RequestWithUser,
  ): Promise<Schedule> {
    return this.scheduleService.update(workbookId, scheduleId, dto, userToActor(req.user));
  }

  @Delete(':scheduleId')
  async delete(
    @Param('workbookId') workbookId: WorkbookId,
    @Param('scheduleId') scheduleId: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    return this.scheduleService.delete(workbookId, scheduleId, userToActor(req.user));
  }
}
