import { Injectable } from '@nestjs/common';
import { Organization } from '@prisma/client';
import { OrganizationId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';

@Injectable()
export class OrganizationsService {
  constructor(private readonly db: DbService) {}

  async findOne(id: OrganizationId): Promise<Organization | null> {
    return await this.db.client.organization.findUnique({ where: { id } });
  }

  async findOneByClerkId(clerkId: string): Promise<Organization | null> {
    return await this.db.client.organization.findFirst({ where: { clerkId } });
  }

  async list(
    limit: number = 10,
    cursor: string | undefined,
  ): Promise<{ organizations: Organization[]; nextCursor: string | undefined }> {
    const organizations = await this.db.client.organization.findMany({
      take: limit + 1,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { id: 'asc' },
    });

    let nextCursor: string | undefined;
    if (organizations.length === limit + 1) {
      const nextOrganization = organizations.pop();
      nextCursor = nextOrganization?.id;
    }

    return { organizations, nextCursor };
  }
}
