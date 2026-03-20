import { Injectable } from '@nestjs/common';
import { DataFolderId } from '@spinner/shared-types';
import { Actor } from 'src/users/types';
import { DataFolderService } from 'src/workbook/data-folder.service';
import { McpToolCallResult, McpToolDefinition } from '../dto/mcp-messages.dto';
import { McpTool } from './tool-registry';

@Injectable()
export class GetFolderSchemaTool implements McpTool {
  readonly name = 'get_folder_schema';

  readonly definition: McpToolDefinition = {
    name: 'get_folder_schema',
    description:
      'Get the schema/field definitions for a data folder. Returns field names, types, and configuration. Useful for understanding the structure of records in a folder.',
    inputSchema: {
      type: 'object',
      properties: {
        folderId: { type: 'string', description: 'The data folder ID' },
      },
      required: ['folderId'],
    },
  };

  constructor(private readonly dataFolderService: DataFolderService) {}

  async execute(args: Record<string, unknown>, actor: Actor): Promise<McpToolCallResult> {
    const folderId = args.folderId as DataFolderId;

    const schema = await this.dataFolderService.getSchemaPaths(folderId, actor);

    return {
      content: [{ type: 'text', text: JSON.stringify(schema, null, 2) }],
    };
  }
}
