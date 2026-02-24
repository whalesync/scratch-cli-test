import { ScheduleAction } from '../enums/enums';
import { OrganizationId, ScheduleId, WorkbookId } from '../ids';

///
/// NOTE: Keep this in sync with server/prisma/schema.prisma Schedule model
/// Begin "keep in sync" section
///

export interface Schedule {
  id: ScheduleId;
  createdAt: string;
  updatedAt: string;
  workbookId: WorkbookId;
  organizationId: OrganizationId;
  userId: string | null;
  name: string;
  action: ScheduleAction;
  entityId: string;
  cronExpression: string;
  enabled: boolean;
  lastTriggeredAt: string | null;
  nextRunAt: string | null;
}

///
/// End "keep in sync" section
///
