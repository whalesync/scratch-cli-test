import type { CreateBugReportDto } from '../../dto/bug-report/create-bug-report.dto';
import type { Http } from '../http';

export function createBugReportApi(http: Http) {
  return {
    report: async (dto: CreateBugReportDto): Promise<{ issueId: string | undefined; link: string | undefined }> => {
      const res = await http.post<{ issueId: string | undefined; link: string | undefined }>('/bugs/report', dto, {
        fallbackMessage: 'Failed to report bug',
      });
      return res.data;
    },
  };
}

export type BugReportApi = ReturnType<typeof createBugReportApi>;
