import { z } from 'zod';
import type { WorkbookId } from '../../ids';

export const createDataFolderSchema = z.object({
  name: z.string().min(1),
  workbookId: z.string().min(1),
  connectorAccountId: z.string().optional(),
  tableId: z.array(z.string()).optional(),
  parentFolderId: z.string().optional(),
  filter: z.string().optional(),
  options: z.record(z.string(), z.unknown()).optional(),
  idFieldOverride: z.string().optional(),
  nameFieldOverride: z.array(z.string()).optional(),
  triggerPull: z.boolean().optional(),
});

// `workbookId` is validated as a string but carries the branded `WorkbookId` type for consumers.
export type CreateDataFolderDto = Omit<z.infer<typeof createDataFolderSchema>, 'workbookId'> & {
  workbookId: WorkbookId;
};

// Required fields (`name`, `workbookId`) are already required by the schema, so the
// "validated" variant is just the DTO itself; kept for backwards-compatible imports.
export type ValidatedCreateDataFolderDto = CreateDataFolderDto;
