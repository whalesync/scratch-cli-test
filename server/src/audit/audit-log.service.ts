import { Injectable } from '@nestjs/common';
import { AuditLogEvent, Prisma } from '@prisma/client';
import { AnyId, createAuditLogEventId } from '@spinner/shared-types';
import { Actor } from 'src/users/types';
import { DbService } from '../db/db.service';
import { AuditLogEventType } from './types';

@Injectable()
export class AuditLogService {
  constructor(private readonly dbService: DbService) {}

  async logEvent(args: {
    actor: Actor;
    eventType: AuditLogEventType;
    message: string;
    entityId: AnyId;
    context?: Prisma.InputJsonObject;
    organizationId?: string;
  }): Promise<AuditLogEvent> {
    // write the event to the database
    return this.dbService.client.auditLogEvent.create({
      data: {
        id: createAuditLogEventId(),
        userId: args.actor.userId,
        organizationId: args.organizationId ?? args.actor.organizationId,
        eventType: args.eventType,
        message: args.message,
        entityId: args.entityId,
        context: args.context || undefined,
      },
    });
  }

  async findEventsForUser(userId: string, take: number, cursor: string | undefined): Promise<AuditLogEvent[]> {
    return this.dbService.client.auditLogEvent.findMany({
      where: {
        userId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take,
      skip: cursor ? 1 : undefined,
      cursor: cursor ? { id: cursor } : undefined,
    });
  }

  async findEventsForOrganization(
    organizationId: string,
    take: number,
    cursor: string | undefined,
  ): Promise<AuditLogEvent[]> {
    return this.dbService.client.auditLogEvent.findMany({
      where: {
        organizationId,
      },
      orderBy: {
        createdAt: 'desc',
      },
      take,
      skip: cursor ? 1 : undefined,
      cursor: cursor ? { id: cursor } : undefined,
    });
  }
}
