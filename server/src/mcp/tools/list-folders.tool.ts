import { Injectable } from '@nestjs/common';
import { WorkbookId } from '@spinner/shared-types';
import { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { McpToolCallResult, McpToolDefinition } from '../dto/mcp-messages.dto';
import { McpTool } from './tool-registry';

@Injectable()
export class ListFoldersTool implements McpTool {
  readonly name = 'list_folders';

  readonly definition: McpToolDefinition = {
    name: 'list_folders',
    description:
      'List data folders in a workbook. Data folders represent directories that contain record files. Returns folder IDs, names, paths, and connected service info.',
    inputSchema: {
      type: 'object',
      properties: {
        workbookId: { type: 'string', description: 'The workbook ID' },
      },
      required: ['workbookId'],
    },
  };

  constructor(private readonly dataFolderService: DataFolderService) {}

  async execute(args: Record<string, unknown>, actor: Actor): Promise<McpToolCallResult> {
    const workbookId = args.workbookId as WorkbookId;
    const folders = await this.dataFolderService.listAll(workbookId, actor);

    const result = folders.map((f) => ({
      id: f.id,
      name: f.name,
      path: f.path,
      service: f.connectorService ?? null,
      connectorDisplayName: f.connectorDisplayName ?? null,
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
}
