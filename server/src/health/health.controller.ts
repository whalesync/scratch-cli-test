import { ClassSerializerInterceptor, Controller, Get, Header, StreamableFile, UseInterceptors } from '@nestjs/common';
import { createReadStream } from 'fs';
import IORedis from 'ioredis';
import { join } from 'path';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { BUILD_VERSION } from 'src/version';

interface ConnectionTestResult {
  status: 'ok' | 'error' | 'not_enabled';
  url?: string;
  error?: string;
  build_version?: string;
}

interface ConnectionTestResponse {
  timestamp: string;
  redis: ConnectionTestResult;
  scratch_git: ConnectionTestResult;
  scratch_git_http: ConnectionTestResult;
}

/**
 * Health check endpoint for the Scratch API.
 *
 * NOTE: It is *not* auth guarded because it only returns basic helpful info for monitoring services.
 */
@Controller()
@UseInterceptors(ClassSerializerInterceptor)
export class HealthController {
  constructor(private readonly configService: ScratchConfigService) {}

  @Get('favicon.ico')
  @Header('Content-Type', 'image/x-icon')
  @Header('Cache-Control', 'public, max-age=86400')
  getFavicon(): StreamableFile {
    const file = createReadStream(join(__dirname, '..', 'assets', 'favicon.ico'));
    return new StreamableFile(file);
  }

  @Get()
  getRoot() {
    return {
      server: 'Scratch API',
      build_version: BUILD_VERSION,
    };
  }

  @Get('health')
  getHealth() {
    return {
      status: 'alive',
      timestamp: new Date().toISOString(),
      service: 'scratch-api',
      build_version: BUILD_VERSION,
      in_cloud: ScratchConfigService.isRunningInCloudRun(),
      app_url: ScratchConfigService.getClientBaseUrl(),
      apptype: ScratchConfigService.getServiceTypes(),
    };
  }

  /**
   * Verifies the micro-services this server can talk to to ensure it has access
   * @returns A JSON response with a list of microservices and the connection status
   */
  @Get('service-check')
  async getConnectionTest(): Promise<ConnectionTestResponse> {
    const [redis, scratchGit, scratchGitHttp] = await Promise.all([
      this.testRedis(),
      this.testScratchGit(),
      this.testScratchGitHttp(),
    ]);

    return {
      timestamp: new Date().toISOString(),
      redis,
      scratch_git: scratchGit,
      scratch_git_http: scratchGitHttp,
    };
  }

  /**
   * Returns the external IP address of this server as seen by external services.
   * Useful for verifying Cloud NAT static IP configuration.
   */
  @Get('egress-ip')
  async getEgressIp() {
    try {
      const response = await fetch('https://api.ipify.org?format=json', {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return {
          error: `ipify returned ${response.status}`,
          timestamp: new Date().toISOString(),
        };
      }

      const data = (await response.json()) as { ip: string };

      return {
        egress_ip: data.ip,
        timestamp: new Date().toISOString(),
        service: 'api',
      };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      };
    }
  }

  private async testRedis(): Promise<ConnectionTestResult> {
    let client: IORedis | undefined;
    try {
      client = new IORedis({
        host: this.configService.getRedisHost(),
        port: this.configService.getRedisPort(),
        password: this.configService.getRedisPassword(),
        connectTimeout: 5000,
        lazyConnect: true,
      });
      await client.connect();
      const pong = await client.ping();
      return pong === 'PONG'
        ? { status: 'ok' as const }
        : { status: 'error' as const, error: `Unexpected ping response: ${String(pong)}` };
    } catch (err) {
      return { status: 'error', error: err instanceof Error ? err.message : String(err) };
    } finally {
      await client?.quit().catch(() => {});
    }
  }

  private async testScratchGit(): Promise<ConnectionTestResult> {
    const scratchGitUrl = this.configService.getScratchGitApiUrl();
    if (!scratchGitUrl) {
      return { status: 'not_enabled' };
    }

    const healthUrl = `${scratchGitUrl}/health`;
    try {
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const body = (await response.json()) as { build_version?: string };
        return { status: 'ok', url: scratchGitUrl, build_version: body.build_version };
      }
      return { status: 'error', url: scratchGitUrl, error: `HTTP ${response.status}: ${await response.text()}` };
    } catch (err) {
      return { status: 'error', url: scratchGitUrl, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async testScratchGitHttp(): Promise<ConnectionTestResult> {
    const backendUrl = this.configService.getScratchGitBackendUrl();
    if (!backendUrl) {
      return { status: 'not_enabled' };
    }

    const healthUrl = `${backendUrl}/health`;
    try {
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      });
      if (response.ok) {
        const body = (await response.json()) as { build_version?: string };
        return { status: 'ok', url: backendUrl, build_version: body.build_version };
      }
      return { status: 'error', url: backendUrl, error: `HTTP ${response.status}: ${await response.text()}` };
    } catch (err) {
      return { status: 'error', url: backendUrl, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
