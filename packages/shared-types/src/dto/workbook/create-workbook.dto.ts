import { z } from 'zod';
import { WorkbookManager } from '../../enums/enums';
import { LiveExportEngine } from '../../live-export/live-export-engine';

export const createWorkbookSchema = z.object({
  name: z.string().optional(),
  // Which external app manages this workbook. Omit (or pass null) for a standalone
  // Scratch workbook; Whalesync's CRM Mirror (via dusky) passes `ws_export`. The enum
  // here is the API-level enforcement of the valid values.
  managedBy: z.nativeEnum(WorkbookManager).nullish(),
  // Live Exports only (`managedBy: ws_export`): which engine runs the export, stored as the workbook's
  // `live_export_engine` setting (see live-export-engine.ts). Omit (or pass null) for the default,
  // classic. Changeable later through `PATCH /workbook/:id/settings`.
  liveExportEngine: z.enum([LiveExportEngine.CLASSIC, LiveExportEngine.RUN_STORE]).nullish(),
});

export type CreateWorkbookDto = z.infer<typeof createWorkbookSchema>;
export type ValidatedCreateWorkbookDto = CreateWorkbookDto;
