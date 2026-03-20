import { Injectable } from '@nestjs/common';
import { DataFolderId, WorkbookId } from '@spinner/shared-types';
import { Actor } from 'src/users/types';
import { FilesService } from 'src/workbook/files.service';
import { McpToolCallResult, McpToolDefinition } from '../dto/mcp-messages.dto';
import { McpTool } from './tool-registry';

@Injectable()
export class ListFilesTool implements McpTool {
  readonly name = 'list_files';

  readonly definition: McpToolDefinition = {
    name: 'list_files',
    description:
      'List record files in a data folder. Returns file names, paths, and summary metadata. Use pagination cursor for large folders.',
    inputSchema: {
      type: 'object',
      properties: {
        workbookId: { type: 'string', description: 'The workbook ID' },
        folderId: { type: 'string', description: 'The data folder ID' },
        cursor: { type: 'string', description: 'Pagination cursor from previous response' },
        limit: { type: 'number', description: 'Max files to return (default 50, max 200)' },
      },
      required: ['workbookId', 'folderId'],
    },
  };

  constructor(private readonly filesService: FilesService) {}

  async execute(args: Record<string, unknown>, actor: Actor): Promise<McpToolCallResult> {
    const workbookId = args.workbookId as WorkbookId;
    const folderId = args.folderId as DataFolderId;
    const cursor = args.cursor as string | undefined;
    const limit = Math.min((args.limit as number) ?? 50, 200);

    const result = await this.filesService.listByFolderId(workbookId, folderId, actor, { cursor, limit });

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
}
