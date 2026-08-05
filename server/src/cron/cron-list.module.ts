import { Module } from '@nestjs/common';
import { CronController } from './cron.controller';

/**
 * Serves the read-only cron dev-tool list (`GET /cron/jobs`) on the API service — the one the browser
 * talks to. Kept separate from {@link CronModule} so the API service can list cron jobs without loading
 * `ScheduleModule.forRoot()` or the `@Cron` services, which would double-fire every cron job.
 *
 * Mounted when `isAPIService()` (see `app.module.ts`). In the local monolith it coexists with
 * `CronModule` — `CronController` (this module) owns `GET /cron/jobs`, `CronDebugController` (CronModule)
 * owns `POST /cron/jobs/:slug/trigger`, so the routes never collide. Needs no imports: `ScratchAuthGuard`'s
 * strategies are registered globally by `AuthModule`.
 */
@Module({
  controllers: [CronController],
})
export class CronListModule {}
