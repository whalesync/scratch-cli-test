import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import knex, { Knex } from 'knex';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { WSLogger } from 'src/logger';

@Injectable()
export class DbService implements OnModuleInit, OnApplicationShutdown {
  private _client: PrismaClient;

  constructor(private readonly config: ScratchConfigService) {
    this._client = new PrismaClient({
      datasources: { db: { url: this.config.getDatabaseUrl() } },
    });
  }

  public get client(): PrismaClient {
    return this._client;
  }

  /**
   * Run one Prisma query with a custom (per-execution) query plan — see
   * {@link runQueryWithCustomPlanForBoundParameterValues} for why bulk `IN` lookups need this.
   */
  async runQueryWithCustomPlanForBoundParameterValues<T>(query: Prisma.PrismaPromise<T>): Promise<T> {
    return runQueryWithCustomPlanForBoundParameterValues(this._client, query);
  }

  /**
   * Creates a Knex instance with proper SSL configuration for CloudSQL.
   * Removes sslmode from connection string as it overrides the ssl object config.
   * We still use SSL but configure it via the ssl object to disable cert verification.
   * See https://node-postgres.com/features/ssl#usage-with-connectionstring
   */
  public knexClient(options?: { searchPath?: string[] }): Knex {
    const connectionString = this.config.getDatabaseUrl();
    const url = new URL(connectionString);

    // sslmode=allow means attempt an insecure connection first, so it implies we don't need it
    // and sslmode=disable means don't use it at all.
    const needsSsl = !['disable', 'allow'].includes(url.searchParams.get('sslmode') ?? 'disable');
    if (needsSsl) {
      // Delete the param so we can customize the SSL configuration in the client options
      url.searchParams.delete('sslmode');
    }

    return knex({
      client: 'pg',
      connection: {
        connectionString: url.toString(),
        ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
      },
      searchPath: options?.searchPath ?? ['public'],
      debug: this.config.getDbDebug(),
      asyncStackTraces: true,
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this._client.$connect();
    } catch (error: unknown) {
      WSLogger.error({
        source: 'DbService.onModuleInit',
        message: 'Failed to connect to DB',
        error,
      });
      process.exit(1);
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this._client.$disconnect();
  }
}

/**
 * Run one Prisma query with Postgres planning it for the values actually bound to it
 * (`plan_cache_mode = force_custom_plan`, transaction-local), instead of reusing a cached
 * generic plan.
 *
 * Why this exists: Prisma caches each distinct SQL text as a named prepared statement per
 * connection, and after 5 executions Postgres may switch that statement to a generic plan —
 * one built without looking at the parameter values. For a bulk lookup like
 * `workbookId = $1 AND folderPath = $2 AND recordId IN ($3..$1002)`, the generic plan
 * estimates the `(workbookId, folderPath)` prefix at the table-wide average (~50 rows), so it
 * walks the whole folder through any `(workbookId, folderPath, …)` index and checks every row
 * against the 1000-element list. For a large tenant that is catastrophic: on prod a 110k-row
 * folder took 7–12 s of pure CPU per 1000-id chunk under the generic plan versus 15–27 ms
 * under a custom plan that probes the unique index.
 *
 * Use this for bulk `IN (...)` lookups keyed by a skewed tenant column (workbookId, syncId,
 * dataFolderId). `set_config(..., true)` only lasts until the end of this batch transaction,
 * so nothing else on the pooled connection is affected.
 */
export async function runQueryWithCustomPlanForBoundParameterValues<T>(
  prismaClient: PrismaClient,
  query: Prisma.PrismaPromise<T>,
): Promise<T> {
  const [, result] = await prismaClient.$transaction([
    prismaClient.$queryRaw`SELECT set_config('plan_cache_mode', 'force_custom_plan', true)`,
    query,
  ]);
  return result;
}
