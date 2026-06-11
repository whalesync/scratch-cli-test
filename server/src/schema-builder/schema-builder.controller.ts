import { Body, Controller, Param, Post, Req, UseGuards } from '@nestjs/common';
import type {
  CreateSchemaFieldsResponse,
  CreateSchemaTablesResponse,
  GenerateCreatePlanResponse,
  ValidateSchemaResponse,
  WorkbookId,
} from '@spinner/shared-types';
import { ScratchAuthGuard } from '../auth/scratch-auth.guard';
import type { RequestWithUser } from '../auth/types';
import { ApiRateLimitGuard } from '../rate-limiter/api-rate-limit.guard';
import { userToActor } from '../users/types';
import { CreateSchemaFieldsDto, CreateSchemaTablesDto, GenerateCreatePlanDto } from './dto/create-schema.dto';
import { SchemaBuilderService } from './schema-builder.service';

/**
 * Create-schema API (DEV-10378). Create new tables and fields on a remote data
 * source through a connector, in a connector-agnostic logical vocabulary.
 *
 * Endpoint composition: plan-from-folder (derive an editable plan) → validate
 * (dry-run) → tables / fields (execute). `plan-from-folder` and `validate` are
 * read-only and fully functional now; `tables`/`fields` return a `not_supported`
 * status until a connector opts into schema creation.
 */
@Controller('workbook/:workbookId/schema')
@UseGuards(ScratchAuthGuard, ApiRateLimitGuard)
export class SchemaBuilderController {
  constructor(private readonly schemaBuilderService: SchemaBuilderService) {}

  /** Derive a create-tables plan from one or more existing source DataFolders. */
  @Post('plan-from-folder')
  async planFromFolder(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() dto: GenerateCreatePlanDto,
    @Req() req: RequestWithUser,
  ): Promise<GenerateCreatePlanResponse> {
    return this.schemaBuilderService.generatePlan(workbookId, dto, userToActor(req.user));
  }

  /** Dry-run validation of a create-tables body — never touches the remote service. */
  @Post('validate')
  async validate(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() body: unknown,
    @Req() req: RequestWithUser,
  ): Promise<ValidateSchemaResponse> {
    return this.schemaBuilderService.validate(workbookId, body, userToActor(req.user));
  }

  /** Create one or more tables (with their fields) on the remote service. */
  @Post('tables')
  async createTables(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() dto: CreateSchemaTablesDto,
    @Req() req: RequestWithUser,
  ): Promise<CreateSchemaTablesResponse> {
    return this.schemaBuilderService.createTables(workbookId, dto, userToActor(req.user));
  }

  /** Add fields to an existing remote table. */
  @Post('fields')
  async createFields(
    @Param('workbookId') workbookId: WorkbookId,
    @Body() dto: CreateSchemaFieldsDto,
    @Req() req: RequestWithUser,
  ): Promise<CreateSchemaFieldsResponse> {
    return this.schemaBuilderService.createFields(workbookId, dto, userToActor(req.user));
  }
}
