import type { Schedule } from '../../db/schedule';
import type { CreateScheduleDto } from '../../dto/schedule/create-schedule.dto';
import type { UpdateScheduleDto } from '../../dto/schedule/update-schedule.dto';
import type { ScheduleAction } from '../../enums/enums';
import type { Http } from '../http';

/**
 * Schedule CRUD for a workbook (create, list, by-entity lookup, detail, update, delete). Reached
 * as `client.schedule.*`. CLIENT-ONLY — there is no desktop schedule module.
 */
export function createScheduleApi(http: Http) {
  return {
    create: async (workbookId: string, dto: CreateScheduleDto): Promise<Schedule> => {
      const res = await http.post<Schedule>(`/workbooks/${workbookId}/schedules`, dto, {
        fallbackMessage: 'Failed to create schedule',
      });
      return res.data;
    },

    list: async (workbookId: string): Promise<Schedule[]> => {
      const res = await http.get<Schedule[]>(`/workbooks/${workbookId}/schedules`, {
        fallbackMessage: 'Failed to list schedules',
      });
      return res.data;
    },

    findByEntity: async (workbookId: string, action: ScheduleAction, entityId: string): Promise<Schedule | null> => {
      const res = await http.get<Schedule | null>(`/workbooks/${workbookId}/schedules/by-entity`, {
        params: { action, entityId },
        fallbackMessage: 'Failed to find schedule',
      });
      return res.data;
    },

    detail: async (workbookId: string, scheduleId: string): Promise<Schedule> => {
      const res = await http.get<Schedule>(`/workbooks/${workbookId}/schedules/${scheduleId}`, {
        fallbackMessage: 'Failed to get schedule',
      });
      return res.data;
    },

    update: async (workbookId: string, scheduleId: string, dto: UpdateScheduleDto): Promise<Schedule> => {
      const res = await http.patch<Schedule>(`/workbooks/${workbookId}/schedules/${scheduleId}`, dto, {
        fallbackMessage: 'Failed to update schedule',
      });
      return res.data;
    },

    delete: async (workbookId: string, scheduleId: string): Promise<void> => {
      await http.delete(`/workbooks/${workbookId}/schedules/${scheduleId}`, {
        fallbackMessage: 'Failed to delete schedule',
      });
    },
  };
}

export type ScheduleApi = ReturnType<typeof createScheduleApi>;
