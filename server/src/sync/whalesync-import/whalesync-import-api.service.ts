import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type {
  WhalesyncImportPreviewBody,
  WhalesyncImportPreviewResponse,
  WhalesyncSyncExport,
  WorkbookId,
} from '@spinner/shared-types';
import axios from 'axios';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';
import { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { z } from 'zod';
import { convertWhalesyncExport } from './whalesync-import.service';

const importPreviewBodySchema = z.object({
  whalesyncApiToken: z.string().min(1, 'whalesyncApiToken is required'),
  coreBaseId: z.string().min(1, 'coreBaseId is required'),
});

@Injectable()
export class WhalesyncImportApiService {
  constructor(
    private readonly dataFolderService: DataFolderService,
    private readonly configService: ScratchConfigService,
  ) {}

  async previewImport(
    workbookId: WorkbookId,
    body: WhalesyncImportPreviewBody,
    actor: Actor,
  ): Promise<WhalesyncImportPreviewResponse> {
    const parsed = importPreviewBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(`Invalid request body: ${parsed.error.message}`);
    }

    const wsExport = await this.fetchBottlenoseExport(parsed.data.whalesyncApiToken, parsed.data.coreBaseId);
    const dataFolders = await this.dataFolderService.listAll(workbookId, actor);
    return convertWhalesyncExport(dataFolders, wsExport);
  }

  private async fetchBottlenoseExport(apiToken: string, coreBaseId: string): Promise<WhalesyncSyncExport> {
    const baseUrl = this.configService.getWhalesyncApiUrl();
    const url = `${baseUrl}/rest/core-bases/${encodeURIComponent(coreBaseId)}/export`;

    let data: unknown;
    try {
      const response = await axios.get(url, {
        headers: { Authorization: `WS-API-Token ${apiToken}` },
      });
      data = response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 401 || status === 403) {
          throw new UnauthorizedException('Invalid or expired Whalesync API token');
        }
        if (status === 404) {
          throw new NotFoundException(`Core base "${coreBaseId}" not found in Whalesync`);
        }
        WSLogger.warn({
          source: 'WhalesyncImportApiService',
          message: 'Bottlenose export request failed',
          status,
          errorMessage: error.message,
        });
      } else {
        WSLogger.warn({
          source: 'WhalesyncImportApiService',
          message: 'Unexpected error fetching bottlenose export',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
      throw new BadGatewayException('Failed to fetch export from Whalesync');
    }

    if (!isValidExportResponse(data)) {
      throw new BadGatewayException('Invalid response from Whalesync export API');
    }

    return data;
  }
}

function isValidExportResponse(data: unknown): data is WhalesyncSyncExport {
  return (
    typeof data === 'object' &&
    data !== null &&
    'version' in data &&
    (data as Record<string, unknown>).version === 1 &&
    'sources' in data &&
    'tablePairs' in data
  );
}
