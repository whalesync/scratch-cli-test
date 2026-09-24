import { Prisma, PrismaClient } from '@prisma/client';
import { DbService, runQueryWithCustomPlanForBoundParameterValues } from 'src/db/db.service';

/**
 * A `DbService` backed by the test's own `PrismaClient` (the real `DbService` builds its own
 * client from config). Carries the query helpers services call on `DbService`, so a service under
 * test runs the production query path instead of tripping over a missing method.
 */
export function createIntegrationTestDbService(prisma: PrismaClient): DbService {
  return {
    client: prisma,
    runQueryWithCustomPlanForBoundParameterValues: <T>(query: Prisma.PrismaPromise<T>) =>
      runQueryWithCustomPlanForBoundParameterValues(prisma, query),
  } as unknown as DbService;
}
