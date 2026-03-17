import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { ScratchConfigService } from 'src/config/scratch-config.service';

@Injectable()
export class DbService implements OnModuleInit, OnApplicationShutdown {
  private _client: PrismaClient;

  constructor(private readonly config: ScratchConfigService) {
    this._client = new PrismaClient({
      datasources: { db: { url: this.config.getDatabaseUrl() } },
    });
  }

  get client(): PrismaClient {
    return this._client;
  }

  async onModuleInit(): Promise<void> {
    await this._client.$connect();
  }

  async onApplicationShutdown(): Promise<void> {
    await this._client.$disconnect();
  }
}
