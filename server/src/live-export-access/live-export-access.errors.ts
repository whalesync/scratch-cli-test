import { ForbiddenException } from '@nestjs/common';
import { LIVE_EXPORT_PAUSED_ERROR, LiveExportCadence, LiveExportPausedError } from '@spinner/shared-types';
import { describeLiveExportCadence } from './live-export-access-rules';

/**
 * Shown to the person whose Live Export run, or sync or publish job, was refused because Whalesync paused the team's
 * Live Exports. It becomes a refused job's `DbJob.error`, shown verbatim.
 */
export const LIVE_EXPORT_PAUSED_MESSAGE =
  "This team's Live Exports are paused in Whalesync. Choose a plan in Whalesync to run them again.";

/** 403 when a Live Export run is refused because Whalesync paused the team's Live Exports (DEV-12983). */
export class LiveExportPausedException extends ForbiddenException {
  constructor() {
    const body: LiveExportPausedError = {
      error: LIVE_EXPORT_PAUSED_ERROR,
      message: LIVE_EXPORT_PAUSED_MESSAGE,
    };
    super(body);
  }
}

/**
 * A scheduled Live Export run skipped because it came sooner after the routine's last scheduled run than the team's
 * fastest speed allows. Only the scheduler triggers scheduled runs, and it logs this as a skipped run, so it carries
 * no HTTP status.
 */
export class LiveExportScheduledRunSoonerThanFastestCadenceError extends Error {
  constructor(
    readonly fastestCadence: LiveExportCadence,
    readonly lastScheduledRunAt: Date,
  ) {
    super(
      `The team's Live Exports run on a schedule at most ${describeLiveExportCadence(fastestCadence)}, and this ` +
        `routine last ran on its schedule at ${lastScheduledRunAt.toISOString()}`,
    );
    this.name = LiveExportScheduledRunSoonerThanFastestCadenceError.name;
  }
}
