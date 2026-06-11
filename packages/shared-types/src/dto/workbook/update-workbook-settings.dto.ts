import { z } from 'zod';

export const updateWorkbookSettingsSchema = z.object({
  /**
   * Only keys present in the map will be updated, other keys will be left unchanged.
   * null values will remove the key from the settings object
   */
  updates: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});

export type UpdateWorkbookSettingsDto = z.infer<typeof updateWorkbookSettingsSchema>;
export type ValidatedUpdateWorkbookSettingsDto = Required<UpdateWorkbookSettingsDto>;
