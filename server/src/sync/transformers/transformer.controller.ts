/* eslint-disable @typescript-eslint/no-unsafe-assignment */
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
import { TestTransformerDto, TestTransformerResponse, WorkbookId } from '@spinner/shared-types';
import get from 'lodash/get';

import { ScratchAuthGuard } from 'src/auth/scratch-auth.guard';
import type { RequestWithUser } from 'src/auth/types';
import { checkWorkspacePermissions } from '../../users/permissions';
import { userToActor } from '../../users/types';
import { FilesService } from '../../workbook/files.service';
import { getTransformer } from './transformer-registry';
@Controller('sync/transformers')
@UseGuards(ScratchAuthGuard)
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

      const fileContent = JSON.parse(fileDetails.file.content);

      // 2. Extract value
      const sourceValue = get(fileContent, dto.path);

      if (sourceValue === undefined) {
        return {
          success: false,
          value: null,
          error: `Path '${dto.path}' not found in file`,
          originalValue: undefined,
        };
      }

      // 3. Get Transformer
      const transformer = getTransformer(dto.transformerConfig.type);
      if (!transformer) {
        return {
          success: false,
          value: null,
          error: `Transformer type '${dto.transformerConfig.type}' not found`,
          originalValue: sourceValue,
        };
      }

      // 4. Transform
      const context = {
        sourceValue,
        sourceRecord: fileContent,
        transformerConfig: dto.transformerConfig,
      };

      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      const result = await transformer.transform(context as any);

      if (result.success) {
        return {
          success: true,
          value: result.value,
          originalValue: sourceValue,
        };
      } else {
        return {
          success: false,
          value: null,
          error: result.error,
          originalValue: sourceValue,
        };
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
