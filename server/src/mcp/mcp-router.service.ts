import { Injectable } from '@nestjs/common';
import { WSLogger } from 'src/logger';
import { Actor } from 'src/users/types';
import { JSON_RPC_ERRORS, JsonRpcResponse } from './dto/jsonrpc.dto';
import { McpInitializeParams, McpInitializeResult, McpToolCallParams } from './dto/mcp-messages.dto';
import { McpSessionService } from './mcp-session.service';
import { ToolRegistry } from './tools/tool-registry';

const PROTOCOL_VERSION = '2025-03-26';
const SERVER_NAME = 'scratch-mcp';
const SERVER_VERSION = '1.0.0';

@Injectable()
export class McpRouterService {
  constructor(
    private readonly toolRegistry: ToolRegistry,
    private readonly sessionService: McpSessionService,
  ) {}

  /**
   * Returns true if the message is a JSON-RPC notification (no id) or response.
   * Notifications don't expect a response.
   */
  isNotification(message: { id?: string | number; method?: string }): boolean {
    return message.id === undefined || message.id === null;
  }

  async handle(
    method: string,
    params: Record<string, unknown> | undefined,
    id: string | number | undefined,
    actor: Actor,
  ): Promise<JsonRpcResponse | null> {
    // Notifications get no response
    if (id === undefined || id === null) {
      return null;
    }

    try {
      const result = await this.dispatch(method, params, actor);
      return { jsonrpc: '2.0', id, result };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      WSLogger.error({
        source: 'McpRouterService.handle',
        message: `Error handling MCP method ${method}`,
        error,
      });
      return {
        jsonrpc: '2.0',
        id,
        error: { code: JSON_RPC_ERRORS.INTERNAL_ERROR.code, message },
      };
    }
  }

  private async dispatch(method: string, params: Record<string, unknown> | undefined, actor: Actor): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return this.handleInitialize(params as unknown as McpInitializeParams, actor);

      case 'tools/list':
        return { tools: this.toolRegistry.listTools() };

      case 'tools/call':
        return this.handleToolCall(params as unknown as McpToolCallParams, actor);

      default:
        throw Object.assign(new Error(`Unknown method: ${method}`), {
          code: JSON_RPC_ERRORS.METHOD_NOT_FOUND.code,
        });
    }
  }

  private async handleInitialize(
    params: McpInitializeParams,
    actor: Actor,
  ): Promise<McpInitializeResult & { sessionId: string }> {
    const session = await this.sessionService.createSession(actor.userId);

    WSLogger.info({
      source: 'McpRouterService.handleInitialize',
      message: 'MCP session initialized',
      userId: actor.userId,
      sessionId: session.sessionId,
      clientInfo: params?.clientInfo,
    });

    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        tools: { listChanged: false },
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      sessionId: session.sessionId,
    };
  }

  private async handleToolCall(params: McpToolCallParams, actor: Actor): Promise<unknown> {
    return this.toolRegistry.dispatch(params.name, params.arguments ?? {}, actor);
  }
}
