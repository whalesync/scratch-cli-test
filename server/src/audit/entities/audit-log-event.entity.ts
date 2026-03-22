import { AuditLogEvent } from '@prisma/client';
import { JsonObject } from '@prisma/client/runtime/library';

export class AuditLogEventEntity {
  id: string;
  userId: string | null;
  organizationId: string | null;
  eventType: string;
  message: string;
  entityId: string;
  context: JsonObject;
  createdAt: Date;

  constructor(auditLogEvent: AuditLogEvent) {
    this.id = auditLogEvent.id;
    this.userId = auditLogEvent.userId;
    this.organizationId = auditLogEvent.organizationId;
    this.eventType = auditLogEvent.eventType;
    this.message = auditLogEvent.message;
    this.entityId = auditLogEvent.entityId;
    this.createdAt = auditLogEvent.createdAt;
    if (auditLogEvent.context) {
      this.context = { ...(auditLogEvent.context as JsonObject) };
    } else {
      this.context = {};
    }
  }
}
