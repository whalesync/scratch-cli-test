import { Injectable } from '@nestjs/common';
import { WorkbookId } from '@spinner/shared-types';
import { Actor } from 'src/users/types';
import { FilesService } from 'src/workbook/files.service';
import { McpToolCallResult, McpToolDefinition } from '../dto/mcp-messages.dto';
import { McpTool } from './tool-registry';

@Injectable()
export class ReadFileTool implements McpTool {
  readonly name = 'read_file';

  readonly definition: McpToolDefinition = {
    name: 'read_file',
    description:
      'Read the full content of a record file by its path. The path is the data folder path + filename (e.g. "/my-folder/record-name.json").',
    inputSchema: {
      type: 'object',
      properties: {
        workbookId: { type: 'string', description: 'The workbook ID' },
        path: { type: 'string', description: 'Full file path (folder path + filename)' },
      },
      required: ['workbookId', 'path'],
    },
  };

  constructor(private readonly filesService: FilesService) {}

  async execute(args: Record<string, unknown>, actor: Actor): Promise<McpToolCallResult> {
    const workbookId = args.workbookId as WorkbookId;
    const path = args.path as string;

    const file = await this.filesService.getFileByPathGit(workbookId, path, actor);

    return {
      content: [{ type: 'text', text: JSON.stringify(file, null, 2) }],
    };
  }
}
