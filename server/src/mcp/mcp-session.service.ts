import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import IORedis from 'ioredis';
import { ScratchConfigService } from 'src/config/scratch-config.service';

export interface McpSession {
  sessionId: string;
  userId: string;
  createdAt: string;
}

const MCP_SESSION_PREFIX = 'mcp:session:';
const MCP_SESSION_TTL = 7200; // 2 hours

@Injectable()
export class McpSessionService {
  private redis: IORedis;

  constructor(private readonly configService: ScratchConfigService) {
    this.redis = new IORedis({
      host: this.configService.getRedisHost(),
      port: this.configService.getRedisPort(),
      password: this.configService.getRedisPassword(),
      maxRetriesPerRequest: null,
    });
  }

  async createSession(userId: string): Promise<McpSession> {
    const session: McpSession = {
      sessionId: randomUUID(),
      userId,
      createdAt: new Date().toISOString(),
    };

    await this.redis.set(`${MCP_SESSION_PREFIX}${session.sessionId}`, JSON.stringify(session), 'EX', MCP_SESSION_TTL);

    return session;
  }

  async getSession(sessionId: string): Promise<McpSession | null> {
    const data = await this.redis.get(`${MCP_SESSION_PREFIX}${sessionId}`);
    if (!data) {
      return null;
    }

    // Refresh TTL on access
    await this.redis.expire(`${MCP_SESSION_PREFIX}${sessionId}`, MCP_SESSION_TTL);

    return JSON.parse(data) as McpSession;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.redis.del(`${MCP_SESSION_PREFIX}${sessionId}`);
  }
}
