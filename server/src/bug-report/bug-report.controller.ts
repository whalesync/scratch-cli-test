import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  ForbiddenException,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ValidatedCreateBugReportDto } from '@spinner/shared-types';
import type { RequestWithUser } from 'src/auth/types';
import { ScratchAuthGuard } from '../auth/scratch-auth.guard';
import { ExperimentsService } from '../experiments/experiments.service';
import { UserFlag } from '../experiments/flags';
import { BugReportService } from './bug-report.service';
import { CreateBugReportDto } from './dto/create-bug-report.dto';

@Controller('bugs')
@UseGuards(ScratchAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class BugReportController {
  constructor(
    private readonly bugReportService: BugReportService,
    private readonly experimentsService: ExperimentsService,
  ) {}

  @Post('report')
  async report(
    @Body() createBugReportDto: CreateBugReportDto,
    @Req() req: RequestWithUser,
  ): Promise<{ issueId: string | undefined; link: string | undefined }> {
    const isEnabled = await this.experimentsService.getBooleanFlag(UserFlag.ENABLE_CREATE_BUG_REPORT, false, req.user);
    if (!isEnabled) {
      throw new ForbiddenException('Bug report feature is not enabled for your account');
    }

    const dto = createBugReportDto as ValidatedCreateBugReportDto;
    // Unlike other controllers, we want to pass the User object directly as this is an action from a user not an organization
    return this.bugReportService.create(dto, req.user);
  }
}
