import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AuthType, type WorkbookId } from '@spinner/shared-types';
import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { ApiRateLimitGuard } from 'src/rate-limiter/api-rate-limit.guard';
import { ConnectorAccountService } from 'src/remote-service/connector-account/connector-account.service';
import { TableList } from 'src/remote-service/connector-account/entities/table-list.entity';
import { userToActor } from 'src/users/types';
import { WorkbookService } from 'src/workbook/workbook.service';
import { CreateCliConnectionDto, type ValidatedCreateCliConnectionDto } from './dtos/cli-connection.dto';

/**
 * Controller for CLI connection (connector account) operations.
 * All endpoints are workbook-scoped and require API token authentication.
 */
@Controller('cli/v1/workbooks/:workbookId/connections')
@UseInterceptors(ClassSerializerInterceptor)
@UseGuards(ScratchAuthGuard, ApiRateLimitGuard)
export class CliConnectionController {
  constructor(
    private readonly connectorAccountService: ConnectorAccountService,
    private readonly workbookService: WorkbookService,
  ) {}

  @Get()
  async list(@Param('workbookId') workbookId: string, @Req() req: RequestWithUser) {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId as WorkbookId);
    const accounts = await this.connectorAccountService.findAll(workbookId as WorkbookId, actor);
    return accounts.map((a) => this.toResponse(a));
  }

  @Post()
  async create(
    @Param('workbookId') workbookId: string,
    @Body() dto: CreateCliConnectionDto,
    @Req() req: RequestWithUser,
  ) {
    const actor = userToActor(req.user);
    await this.workbookService.assertWritableWorkbook(actor, workbookId as WorkbookId);
    const validatedDto = dto as ValidatedCreateCliConnectionDto;

    const account = await this.connectorAccountService.create(
      workbookId as WorkbookId,
      {
        service: validatedDto.service,
        authType: AuthType.USER_PROVIDED_PARAMS,
        userProvidedParams: validatedDto.userProvidedParams,
        displayName: validatedDto.displayName,
      },
      actor,
    );

    return this.toResponse(account);
  }

  @Get(':id')
  async show(@Param('workbookId') workbookId: string, @Param('id') id: string, @Req() req: RequestWithUser) {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId as WorkbookId);
    const account = await this.connectorAccountService.findOne(workbookId as WorkbookId, id, actor);
    if (!account) {
      throw new NotFoundException('Connection not found');
    }
    return this.toResponse(account);
  }

  @Get(':connectorAccountId/tables')
  async listTables(
    @Param('workbookId') workbookId: string,
    @Param('connectorAccountId') connectorAccountId: string,
    @Req() req: RequestWithUser,
  ): Promise<TableList> {
    const actor = userToActor(req.user);
    await this.workbookService.assertReadableWorkbook(actor, workbookId as WorkbookId);
    return this.connectorAccountService.listTables(connectorAccountId, actor);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('workbookId') workbookId: string,
    @Param('id') id: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    const actor = userToActor(req.user);
    await this.workbookService.assertWritableWorkbook(actor, workbookId as WorkbookId);
    await this.connectorAccountService.remove(workbookId as WorkbookId, id, actor);
  }

  private toResponse(account: {
    id: string;
    service: string;
    displayName: string;
    authType: string;
    healthStatus: string | null;
    healthStatusMessage: string | null;
    repoPath: string | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: account.id,
      service: account.service,
      displayName: account.displayName,
      authType: account.authType,
      healthStatus: account.healthStatus,
      healthStatusMessage: account.healthStatusMessage,
      repoPath: account.repoPath ?? undefined,
      createdAt: account.createdAt.toISOString(),
      updatedAt: account.updatedAt.toISOString(),
    };
  }
}
