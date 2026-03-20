import { Body, Controller, Delete, Get, Headers, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import type { RequestWithUser } from 'src/auth/types';
import { userToActor } from 'src/users/types';
import { JsonRpcRequestDto } from './dto/jsonrpc.dto';
import { McpAuthGuard } from './mcp-auth/mcp-auth.guard';
import { McpRouterService } from './mcp-router.service';
import { McpSessionService } from './mcp-session.service';

/**
 * Main MCP endpoint handling Streamable HTTP transport.
 *
 * POST /mcp — JSON-RPC requests and notifications
 * GET  /mcp — SSE stream for server-initiated messages (Phase 2)
 * DELETE /mcp — Terminate the MCP session
 */
@Controller('mcp')
@UseGuards(McpAuthGuard)
export class McpController {
  constructor(
    private readonly mcpRouter: McpRouterService,
    private readonly sessionService: McpSessionService,
  ) {}

  @Post()
  async handlePost(
    @Body() message: JsonRpcRequestDto,
    @Req() req: RequestWithUser,
    @Res() res: Response,
  ): Promise<void> {
    const actor = userToActor(req.user);

    // Handle notifications (no id) — just acknowledge
    if (this.mcpRouter.isNotification(message)) {
      res.status(202).send();
      return;
    }

    const result = await this.mcpRouter.handle(message.method, message.params, message.id, actor);

    if (!result) {
      res.status(202).send();
      return;
    }

    // If this was an initialize request, set the session ID header
    if (message.method === 'initialize' && result.result && typeof result.result === 'object') {
      const initResult = result.result as { sessionId?: string };
      if (initResult.sessionId) {
        res.setHeader('Mcp-Session-Id', initResult.sessionId);
      }
    }

    res.setHeader('Content-Type', 'application/json');
    res.json(result);
  }

  /**
   * SSE endpoint for server-initiated messages.
   * Phase 2: Will stream real-time workbook events.
   */
  @Get()
  async handleGet(
    @Headers('mcp-session-id') sessionId: string | undefined,
    @Req() req: RequestWithUser,
    @Res() res: Response,
  ): Promise<void> {
    if (!sessionId) {
      res.status(400).json({ error: 'Mcp-Session-Id header required' });
      return;
    }

    const session = await this.sessionService.getSession(sessionId);
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // For now, just keep the connection open as a placeholder for Phase 2
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send a keep-alive comment
    res.write(':ok\n\n');

    // Close when client disconnects
    req.on('close', () => {
      res.end();
    });
  }

  @Delete()
  async handleDelete(@Headers('mcp-session-id') sessionId: string | undefined, @Res() res: Response): Promise<void> {
    if (sessionId) {
      await this.sessionService.deleteSession(sessionId);
    }
    res.status(204).send();
  }
}
