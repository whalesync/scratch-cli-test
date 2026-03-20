import { Injectable } from '@nestjs/common';
import { WSLogger } from 'src/logger';
import { Actor } from 'src/users/types';
import { McpToolCallResult, McpToolDefinition } from '../dto/mcp-messages.dto';
import { GetFolderSchemaTool } from './get-folder-schema.tool';
import { ListFilesTool } from './list-files.tool';
import { ListFoldersTool } from './list-folders.tool';
import { ListWorkbooksTool } from './list-workbooks.tool';
import { ReadFileTool } from './read-file.tool';

export interface McpTool {
  name: string;
  definition: McpToolDefinition;
  execute(args: Record<string, unknown>, actor: Actor): Promise<McpToolCallResult>;
}

@Injectable()
export class ToolRegistry {
  private tools: Map<string, McpTool>;

  constructor(
    private readonly listWorkbooks: ListWorkbooksTool,
    private readonly listFolders: ListFoldersTool,
    private readonly listFiles: ListFilesTool,
    private readonly readFile: ReadFileTool,
    private readonly getFolderSchema: GetFolderSchemaTool,
  ) {
    this.tools = new Map<string, McpTool>();
    this.registerTool(this.listWorkbooks);
    this.registerTool(this.listFolders);
    this.registerTool(this.listFiles);
    this.registerTool(this.readFile);
    this.registerTool(this.getFolderSchema);
  }

  private registerTool(tool: McpTool): void {
    this.tools.set(tool.name, tool);
  }

  listTools(): McpToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  async dispatch(name: string, args: Record<string, unknown>, actor: Actor): Promise<McpToolCallResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    try {
      return await tool.execute(args, actor);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      WSLogger.error({
        source: 'ToolRegistry.dispatch',
        message: `Tool ${name} failed`,
        error,
      });
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  }
}
