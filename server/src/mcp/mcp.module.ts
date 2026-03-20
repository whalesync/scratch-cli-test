import { Module } from '@nestjs/common';
import { ScratchConfigModule } from 'src/config/scratch-config.module';
import { DbModule } from 'src/db/db.module';
import { RedisModule } from 'src/redis/redis.module';
import { UserModule } from 'src/users/users.module';
import { WorkbookModule } from 'src/workbook/workbook.module';
import { McpAuthGuard } from './mcp-auth/mcp-auth.guard';
import { McpOAuthController } from './mcp-auth/mcp-oauth.controller';
import { McpOAuthService } from './mcp-auth/mcp-oauth.service';
import { McpRouterService } from './mcp-router.service';
import { McpSessionService } from './mcp-session.service';
import { McpController } from './mcp.controller';
import { GetFolderSchemaTool } from './tools/get-folder-schema.tool';
import { ListFilesTool } from './tools/list-files.tool';
import { ListFoldersTool } from './tools/list-folders.tool';
import { ListWorkbooksTool } from './tools/list-workbooks.tool';
import { ReadFileTool } from './tools/read-file.tool';
import { ToolRegistry } from './tools/tool-registry';

@Module({
  imports: [ScratchConfigModule, DbModule, RedisModule, UserModule, WorkbookModule],
  controllers: [McpController, McpOAuthController],
  providers: [
    McpRouterService,
    McpSessionService,
    McpOAuthService,
    McpAuthGuard,
    ToolRegistry,
    ListWorkbooksTool,
    ListFoldersTool,
    ListFilesTool,
    ReadFileTool,
    GetFolderSchemaTool,
  ],
})
export class McpModule {}
