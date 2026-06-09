import { z } from 'zod';

/**
 * Query parameters for `GET /workbook` (the workbook list endpoint used by the
 * web client and the desktop app's workbook list page).
 *
 * Single source of truth for the list query: the server validates incoming
 * query params against this schema (via `createZodDto` + the global
 * `ZodValidationPipe`), and the desktop/web clients type their request params
 * with `WorkbookListQuery` so a typo in `sortBy`/`sortOrder` is a compile error.
 *
 * Note: query params arrive as strings, so every field here is a string/enum —
 * no numeric coercion is needed.
 */
export const workbookListQuerySchema = z.object({
  connectorAccountId: z.string().optional(),
  sortBy: z.enum(['name', 'createdAt', 'updatedAt']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

export type WorkbookListQuery = z.infer<typeof workbookListQuerySchema>;
