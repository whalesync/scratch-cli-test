import {
  Body,
  ClassSerializerInterceptor,
  Controller,
  NotFoundException,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Service, TestTransformerDto, TestTransformerResponse, WorkbookId } from '@spinner/shared-types';
import get from 'lodash/get';

import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { ApiRateLimitGuard } from 'src/rate-limiter/api-rate-limit.guard';
import { checkWorkspacePermissions } from '../../users/permissions';
import { userToActor } from '../../users/types';
import { FilesService } from '../../workbook/files.service';
import { getTransformer } from './transformer-registry';
import { TransformContext } from './transformer.types';

@Controller('sync/transformers')
@UseGuards(ScratchAuthGuard, ApiRateLimitGuard)
@UseInterceptors(ClassSerializerInterceptor)
export class TransformerController {
  constructor(private readonly filesService: FilesService) {}

  @Post('test')
  async testTransformer(
    @Body() dto: TestTransformerDto,
    @Req() req: RequestWithUser,
  ): Promise<TestTransformerResponse> {
    try {
      const actor = userToActor(req.user);
      checkWorkspacePermissions(actor, dto.workbookId as WorkbookId);

      // 1. Fetch file content
      const fileDetails = await this.filesService.getFileByPathGit(dto.workbookId as WorkbookId, dto.fileId, actor);
      if (!fileDetails.file.content) {
        throw new NotFoundException('File content not found');
      }

      const fileContent = JSON.parse(fileDetails.file.content) as Record<string, unknown>;

      // 2. Extract value
      const sourceValue: unknown = get(fileContent, dto.path);

      if (sourceValue === undefined) {
        return { success: false, value: null, error: `Path '${dto.path}' not found in file` };
      }

      // 3. Get Transformer
      const transformer = getTransformer(dto.transformerConfig.type);
      if (!transformer) {
        return { success: false, value: null, error: `Transformer type '${dto.transformerConfig.type}' not found` };
      }

      // 4. Transform — this preview endpoint only needs sourceValue/sourceRecord;
      //    remaining context fields use safe defaults since no sync is running.
      const context: TransformContext = {
        sourceValue,
        sourceRecord: { id: '', filePath: dto.fileId, fields: fileContent },
        sourceFieldPath: dto.path,
        sourceTableSpec: null,
        sourceService: '' as Service,
        destinationFieldPath: dto.path,
        destinationTableSpec: null,
        destinationService: '' as Service,
        lookupTools: {
          getDestinationMappingForSourceFk: () => Promise.resolve(null),
          lookupFieldFromFkRecord: () => Promise.resolve(undefined),
          getOrCreateDestinationAssetMapping: () => Promise.reject(new Error('Not available in preview')),
          matchDestinationAssetByHash: () => Promise.resolve([]),
        },
        options: dto.transformerConfig.options ?? {},
        phase: 'DATA',
      };

      const result = await transformer.transform(context);

      if (result.success) {
        return { success: true, value: result.value, originalValue: sourceValue };
      } else {
        return { success: false, value: null, error: result.error, originalValue: sourceValue };
      }
    } catch (error) {
      return {
        success: false,
        value: null,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
