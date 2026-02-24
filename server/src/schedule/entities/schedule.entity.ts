import { Schedule as PrismaSchedule } from '@prisma/client';
import { OrganizationId, Schedule, ScheduleAction, ScheduleId, WorkbookId } from '@spinner/shared-types';

export class ScheduleEntity implements Schedule {
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

  constructor(schedule: PrismaSchedule) {
    this.id = schedule.id as ScheduleId;
    this.createdAt = schedule.createdAt.toISOString();
    this.updatedAt = schedule.updatedAt.toISOString();
    this.workbookId = schedule.workbookId as WorkbookId;
    this.organizationId = schedule.organizationId as OrganizationId;
    this.userId = schedule.userId;
    this.name = schedule.name;
    this.action = schedule.action as ScheduleAction;
    this.entityId = schedule.entityId;
    this.cronExpression = schedule.cronExpression;
    this.enabled = schedule.enabled;
    this.lastTriggeredAt = schedule.lastTriggeredAt ? schedule.lastTriggeredAt.toISOString() : null;
    this.nextRunAt = schedule.nextRunAt ? schedule.nextRunAt.toISOString() : null;
  }
}
