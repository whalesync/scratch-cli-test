import { Injectable } from '@nestjs/common';
import { Actor } from 'src/users/types';
import { WorkbookService } from 'src/workbook/workbook.service';
import { McpToolCallResult, McpToolDefinition } from '../dto/mcp-messages.dto';
import { McpTool } from './tool-registry';

@Injectable()
export class ListWorkbooksTool implements McpTool {
  readonly name = 'list_workbooks';

  readonly definition: McpToolDefinition = {
    name: 'list_workbooks',
    description: 'List all workbooks the user has access to. Returns workbook IDs, names, and creation dates.',
    inputSchema: {
      type: 'object',
      properties: {
        sortBy: {
          type: 'string',
          description: 'Sort field: "name", "createdAt", or "updatedAt"',
        },
        sortOrder: {
          type: 'string',
          description: 'Sort order: "asc" or "desc"',
        },
      },
    },
  };

  constructor(private readonly workbookService: WorkbookService) {}

  async execute(args: Record<string, unknown>, actor: Actor): Promise<McpToolCallResult> {
    const sortBy = (args.sortBy as 'name' | 'createdAt' | 'updatedAt') ?? 'createdAt';
    const sortOrder = (args.sortOrder as 'asc' | 'desc') ?? 'desc';

    const workbooks = await this.workbookService.findAllForUser(actor, sortBy, sortOrder);

    const result = workbooks.map((wb) => ({
      id: wb.id,
      name: wb.name,
      createdAt: wb.createdAt,
      updatedAt: wb.updatedAt,
      folderCount: wb.dataFolders.length,
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  }
}
