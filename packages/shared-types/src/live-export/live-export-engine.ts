/**
 * Which engine runs a Live Export's routine runs (docs/plans/2026-09-25-live-export-git-free-run-store):
 *
 * - `classic` — every run persists through git and the Postgres file indexes (the default).
 * - `run_store` — every run works in a disposable per-run store on the git service and keeps no git or
 *   Postgres file state; much faster on large exports.
 *
 * Set per Live Export (per workbook) through the workbook settings map, e.g. from Whalesync's
 * developer options — at creation (`POST /workbook` with `{ "managedBy": "ws_export",
 * "liveExportEngine": "run_store" }`) or later:
 *
 *     PATCH /workbook/:id/settings   { "updates": { "live_export_engine": "run_store" } }
 *     PATCH /workbook/:id/settings   { "updates": { "live_export_engine": null } }   // back to classic
 *
 * Read it back from `GET /workbook/:id` → `settings.live_export_engine` (absent = classic). The engine
 * is fixed per run when the run starts; a change applies from the next run. A run falls back to the
 * classic engine (and says why in the server logs) when the export uses something the run-store engine
 * doesn't support yet (asset transformers, incremental pulls), when the git service has no room for
 * another run store, or while the server's `LIVE_EXPORT_RUN_STORE_ENGINE_DISABLED` kill switch is on.
 */
export const LIVE_EXPORT_ENGINE_WORKBOOK_SETTING_KEY = 'live_export_engine';

export const LiveExportEngine = {
  CLASSIC: 'classic',
  RUN_STORE: 'run_store',
} as const;

export type LiveExportEngine = (typeof LiveExportEngine)[keyof typeof LiveExportEngine];

/** The engine a workbook's settings ask for (anything unrecognized or absent = classic). */
export function liveExportEngineRequestedBySettings(
  settings: Record<string, string | number | boolean> | null | undefined,
): LiveExportEngine {
  return settings?.[LIVE_EXPORT_ENGINE_WORKBOOK_SETTING_KEY] === LiveExportEngine.RUN_STORE
    ? LiveExportEngine.RUN_STORE
    : LiveExportEngine.CLASSIC;
}
