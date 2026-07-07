import { z } from 'zod';
import { WorkbookManager } from '../../enums/enums';

export const createWorkbookSchema = z.object({
  name: z.string().optional(),
  // Which external app manages this workbook. Omit (or pass null) for a standalone
  // Scratch workbook; Whalesync's CRM Mirror (via dusky) passes `ws_export`. The enum
  // here is the API-level enforcement of the valid values.
  managedBy: z.nativeEnum(WorkbookManager).nullish(),
});

export type CreateWorkbookDto = z.infer<typeof createWorkbookSchema>;
export type ValidatedCreateWorkbookDto = CreateWorkbookDto;
