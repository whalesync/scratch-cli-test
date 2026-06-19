import type { Routine, RoutineFileContent } from '../../db/routine';
import type { RoutineRun } from '../../db/routine-run';
import type { CreateRoutineFileDto } from '../../dto/routine/create-routine-file.dto';
import type { UpdateRoutineFileDto } from '../../dto/routine/update-routine-file.dto';
import type { Http } from '../http';

/**
 * Routine operations for a workbook. Routines are YAML files in the workbook config repo under
 * `routines/`; `list`/`reload` return the parsed+joined view, the `*File` methods read and write
 * the raw YAML text the editor edits, and `trigger`/`cancelRun`/`listRuns`/`getRun` drive and
 * observe routine runs. Reached as `client.routine.*`. CLIENT-ONLY.
 */
export function createRoutineApi(http: Http) {
  return {
    /** GET /workbooks/:id/routines — list routines (parsed YAML joined with schedule + latest run). */
    list: async (workbookId: string): Promise<Routine[]> => {
      const res = await http.get<Routine[]>(`/workbooks/${workbookId}/routines`, {
        fallbackMessage: 'Failed to list routines',
      });
      return res.data;
    },

    /** POST /workbooks/:id/routines/reload — re-read routine files from git and sync their schedules. */
    reload: async (workbookId: string): Promise<Routine[]> => {
      const res = await http.post<Routine[]>(`/workbooks/${workbookId}/routines/reload`, undefined, {
        fallbackMessage: 'Failed to reload routines',
      });
      return res.data;
    },

    /** GET /workbooks/:id/routines/file?path=… — read the raw YAML text of one routine file. */
    getFileContent: async (workbookId: string, path: string): Promise<RoutineFileContent> => {
      const res = await http.get<RoutineFileContent>(`/workbooks/${workbookId}/routines/file`, {
        params: { path },
        fallbackMessage: 'Failed to read routine file',
      });
      return res.data;
    },

    /** POST /workbooks/:id/routines/file — create a new routine YAML file (rejects invalid YAML). */
    createFile: async (workbookId: string, dto: CreateRoutineFileDto): Promise<Routine> => {
      const res = await http.post<Routine>(`/workbooks/${workbookId}/routines/file`, dto, {
        fallbackMessage: 'Failed to create routine',
      });
      return res.data;
    },

    /** PUT /workbooks/:id/routines/file — replace an existing routine file's content (rejects invalid YAML). */
    updateFile: async (workbookId: string, dto: UpdateRoutineFileDto): Promise<Routine> => {
      const res = await http.put<Routine>(`/workbooks/${workbookId}/routines/file`, dto, {
        fallbackMessage: 'Failed to save routine',
      });
      return res.data;
    },

    /** DELETE /workbooks/:id/routines/file?path=… — delete a routine YAML file. */
    deleteFile: async (workbookId: string, path: string): Promise<void> => {
      await http.delete(`/workbooks/${workbookId}/routines/file`, {
        params: { path },
        fallbackMessage: 'Failed to delete routine',
      });
    },

    /** POST /workbooks/:id/routines/trigger — start a manual run of one routine (409 if already running). */
    trigger: async (workbookId: string, filePath: string): Promise<RoutineRun> => {
      const res = await http.post<RoutineRun>(
        `/workbooks/${workbookId}/routines/trigger`,
        { filePath },
        { fallbackMessage: 'Failed to trigger routine' },
      );
      return res.data;
    },

    /**
     * GET /workbooks/:id/routine-runs[?routineFilePath=…][&includeJobs=true] — list run history,
     * newest first. With `includeJobs`, each run includes its `steps` and every step its `job`.
     */
    listRuns: async (workbookId: string, routineFilePath?: string, includeJobs?: boolean): Promise<RoutineRun[]> => {
      const res = await http.get<RoutineRun[]>(`/workbooks/${workbookId}/routine-runs`, {
        params: {
          ...(routineFilePath ? { routineFilePath } : {}),
          ...(includeJobs ? { includeJobs: true } : {}),
        },
        fallbackMessage: 'Failed to list routine runs',
      });
      return res.data;
    },

    /**
     * GET /workbooks/:id/routine-runs/:runId[?includeJobs=true] — fetch a single run with its
     * per-step detail. With `includeJobs`, each step also carries its `job`.
     */
    getRun: async (workbookId: string, runId: string, includeJobs?: boolean): Promise<RoutineRun> => {
      const res = await http.get<RoutineRun>(`/workbooks/${workbookId}/routine-runs/${runId}`, {
        params: includeJobs ? { includeJobs: true } : undefined,
        fallbackMessage: 'Failed to read routine run',
      });
      return res.data;
    },

    /** POST /workbooks/:id/routine-runs/:runId/cancel — cancel a running routine run. */
    cancelRun: async (workbookId: string, runId: string): Promise<RoutineRun> => {
      const res = await http.post<RoutineRun>(`/workbooks/${workbookId}/routine-runs/${runId}/cancel`, undefined, {
        fallbackMessage: 'Failed to cancel routine run',
      });
      return res.data;
    },
  };
}

export type RoutineApi = ReturnType<typeof createRoutineApi>;
