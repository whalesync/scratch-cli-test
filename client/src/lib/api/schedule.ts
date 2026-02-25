import {
  CreateScheduleDto,
  Schedule,
  ScheduleAction,
  ScheduleId,
  UpdateScheduleDto,
  WorkbookId,
} from '@spinner/shared-types';
import { API_CONFIG } from './config';
import { handleAxiosError } from './error';

export const scheduleApi = {
  create: async (workbookId: WorkbookId, dto: CreateScheduleDto): Promise<Schedule> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<Schedule>(`/workbooks/${workbookId}/schedules`, dto);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to create schedule');
    }
  },

  list: async (workbookId: WorkbookId): Promise<Schedule[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<Schedule[]>(`/workbooks/${workbookId}/schedules`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to list schedules');
    }
  },

  findByEntity: async (workbookId: WorkbookId, action: ScheduleAction, entityId: string): Promise<Schedule | null> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<Schedule | null>(`/workbooks/${workbookId}/schedules/by-entity`, {
        params: { action, entityId },
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to find schedule');
    }
  },

  detail: async (workbookId: WorkbookId, scheduleId: ScheduleId): Promise<Schedule> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<Schedule>(`/workbooks/${workbookId}/schedules/${scheduleId}`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to get schedule');
    }
  },

  update: async (workbookId: WorkbookId, scheduleId: ScheduleId, dto: UpdateScheduleDto): Promise<Schedule> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.patch<Schedule>(`/workbooks/${workbookId}/schedules/${scheduleId}`, dto);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to update schedule');
    }
  },

  delete: async (workbookId: WorkbookId, scheduleId: ScheduleId): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.delete(`/workbooks/${workbookId}/schedules/${scheduleId}`);
    } catch (error) {
      handleAxiosError(error, 'Failed to delete schedule');
    }
  },
};
