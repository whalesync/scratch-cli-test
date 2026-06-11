import {
  BadRequestException,
  Body,
  ClassSerializerInterceptor,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { CreateDestinationList, WorkbookId, type ValidatedCreateConnectorAccountDto } from '@spinner/shared-types';
import { ScratchAuthGuard } from '../../auth/scratch-auth.guard';
import type { RequestWithUser } from '../../auth/types';
import { checkWorkspacePermissions } from '../../users/permissions';
import { userToActor } from '../../users/types';
import { ConnectorAccountService } from './connector-account.service';
import { CreateConnectorAccountDto, UpdateConnectorAccountDto } from './dto/connector-account.dto';
import { ApiQuotaResponse } from './entities/api-quota.entity';
import { ConnectorAccount } from './entities/connector-account.entity';
import { RevealCredentialsResponse } from './entities/reveal-credentials.entity';
import { TableList, TableSearchResult } from './entities/table-list.entity';
import { TableSchemaPreview } from './entities/table-schema-preview.entity';
import { TestConnectionResponse } from './entities/test-connection.entity';

@Controller('workbooks/:workbookId/connections')
@UseGuards(ScratchAuthGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class ConnectorAccountController {
  constructor(private readonly service: ConnectorAccountService) {}

  @Post()
  async create(
    @Param('workbookId') workbookId: string,
    @Body() createDto: CreateConnectorAccountDto,
    @Req() req: RequestWithUser,
  ): Promise<ConnectorAccount> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId as WorkbookId);
    const dto = createDto as ValidatedCreateConnectorAccountDto;
    return this.service.create(workbookId as WorkbookId, dto, actor);
  }

  @Get()
  async findAll(@Param('workbookId') workbookId: string, @Req() req: RequestWithUser): Promise<ConnectorAccount[]> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId as WorkbookId);
    return this.service.findAll(workbookId as WorkbookId, actor);
  }

  @Get(':id')
  async findOne(
    @Param('workbookId') workbookId: string,
    @Param('id') id: string,
    @Req() req: RequestWithUser,
  ): Promise<ConnectorAccount> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId as WorkbookId);
    return this.service.findOne(workbookId as WorkbookId, id, actor);
  }

  @Get(':connectorAccountId/tables')
  async listTables(
    @Param('workbookId') workbookId: string,
    @Param('connectorAccountId') connectorAccountId: string,
    @Req() req: RequestWithUser,
  ): Promise<TableList> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId as WorkbookId);
    return this.service.listTables(connectorAccountId, actor);
  }

  @Get(':connectorAccountId/create-destinations')
  async listCreateDestinations(
    @Param('workbookId') workbookId: string,
    @Param('connectorAccountId') connectorAccountId: string,
    @Req() req: RequestWithUser,
  ): Promise<CreateDestinationList> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId as WorkbookId);
    return this.service.listCreateDestinations(connectorAccountId, actor);
  }

  @Get(':connectorAccountId/tables/search')
  async searchTables(
    @Param('workbookId') workbookId: string,
    @Param('connectorAccountId') connectorAccountId: string,
    @Query('searchTerm') searchTerm: string,
    @Req() req: RequestWithUser,
  ): Promise<TableSearchResult> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId as WorkbookId);
    return this.service.searchTables(connectorAccountId, searchTerm, actor);
  }

  @Get(':connectorAccountId/tables/schema')
  async getTableSchema(
    @Param('workbookId') workbookId: string,
    @Param('connectorAccountId') connectorAccountId: string,
    @Query('tableRemoteId') tableRemoteId: string,
    @Req() req: RequestWithUser,
  ): Promise<TableSchemaPreview> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId as WorkbookId);
    if (!tableRemoteId?.trim()) {
      throw new BadRequestException('tableRemoteId is required');
    }
    const remoteIdParts = tableRemoteId.split(',');
    return this.service.getTableSchema(workbookId as WorkbookId, connectorAccountId, remoteIdParts, actor);
  }

  @Post(':id/test')
  async testConnection(
    @Param('workbookId') workbookId: string,
    @Param('id') id: string,
    @Req() req: RequestWithUser,
  ): Promise<TestConnectionResponse> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId as WorkbookId);
    return this.service.testConnection(workbookId as WorkbookId, id, actor);
  }

  @Get(':id/quota')
  async getApiQuota(
    @Param('workbookId') workbookId: string,
    @Param('id') id: string,
    @Req() req: RequestWithUser,
  ): Promise<ApiQuotaResponse> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId as WorkbookId);
    return this.service.getApiQuota(workbookId as WorkbookId, id, actor);
  }

  @Patch(':id')
  async update(
    @Param('workbookId') workbookId: string,
    @Param('id') id: string,
    @Body() updateDto: UpdateConnectorAccountDto,
    @Req() req: RequestWithUser,
  ): Promise<ConnectorAccount> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId as WorkbookId);
    const dto = updateDto;
    return this.service.update(workbookId as WorkbookId, id, dto, actor);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(
    @Param('workbookId') workbookId: string,
    @Param('id') id: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId as WorkbookId);
    return this.service.remove(workbookId as WorkbookId, id, actor);
  }

  @Post(':id/reset')
  @HttpCode(204)
  async reset(
    @Param('workbookId') workbookId: string,
    @Param('id') id: string,
    @Req() req: RequestWithUser,
  ): Promise<void> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId as WorkbookId);
    return this.service.resetConnection(workbookId as WorkbookId, id, actor);
  }

  @Get(':id/credentials/reveal')
  async revealCredentials(
    @Param('workbookId') workbookId: string,
    @Param('id') id: string,
    @Req() req: RequestWithUser,
  ): Promise<RevealCredentialsResponse> {
    const actor = userToActor(req.user);
    checkWorkspacePermissions(actor, workbookId as WorkbookId);
    return this.service.revealCredentials(workbookId as WorkbookId, id, actor);
  }
}
