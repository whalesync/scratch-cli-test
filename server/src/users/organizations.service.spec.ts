/* eslint-disable @typescript-eslint/unbound-method */
import { Organization } from '@prisma/client';
import { OrganizationId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { OrganizationsService } from './organizations.service';

describe('OrganizationsService', () => {
  let service: OrganizationsService;
  let dbService: jest.Mocked<DbService>;

  const mockOrganization: Organization = {
    id: 'org_123' as OrganizationId,
    name: 'Test Organization',
    clerkId: 'clerk_org_123',
    deleted: false,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
  };

  beforeEach(() => {
    // Create mock DB service
    dbService = {
      client: {
        organization: {
          findUnique: jest.fn(),
          findFirst: jest.fn(),
          findMany: jest.fn(),
        },
      },
    } as unknown as jest.Mocked<DbService>;

    service = new OrganizationsService(dbService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findOne', () => {
    it('should find organization by id', async () => {
      const orgId = 'org_123' as OrganizationId;

      (dbService.client.organization.findUnique as jest.Mock).mockResolvedValue(mockOrganization);

      const result = await service.findOne(orgId);

      expect(result).toEqual(mockOrganization);
      expect(dbService.client.organization.findUnique).toHaveBeenCalledWith({ where: { id: orgId } });
      expect(dbService.client.organization.findUnique).toHaveBeenCalledTimes(1);
    });

    it('should return null when organization does not exist', async () => {
      const orgId = 'org_nonexistent' as OrganizationId;

      (dbService.client.organization.findUnique as jest.Mock).mockResolvedValue(null);

      const result = await service.findOne(orgId);

      expect(result).toBeNull();
      expect(dbService.client.organization.findUnique).toHaveBeenCalledWith({ where: { id: orgId } });
    });

    it('should handle organization IDs with special characters', async () => {
      const orgId = 'org_special-chars_123.456' as OrganizationId;

      (dbService.client.organization.findUnique as jest.Mock).mockResolvedValue(null);

      await service.findOne(orgId);

      expect(dbService.client.organization.findUnique).toHaveBeenCalledWith({
        where: { id: 'org_special-chars_123.456' },
      });
    });

    it('should handle database errors', async () => {
      const orgId = 'org_123' as OrganizationId;
      const dbError = new Error('Database connection failed');

      (dbService.client.organization.findUnique as jest.Mock).mockRejectedValue(dbError);

      await expect(service.findOne(orgId)).rejects.toThrow('Database connection failed');
    });
  });

  describe('findOneByClerkId', () => {
    it('should find organization by clerk id', async () => {
      const clerkId = 'clerk_org_123';

      (dbService.client.organization.findFirst as jest.Mock).mockResolvedValue(mockOrganization);

      const result = await service.findOneByClerkId(clerkId);

      expect(result).toEqual(mockOrganization);
      expect(dbService.client.organization.findFirst).toHaveBeenCalledWith({ where: { clerkId } });
      expect(dbService.client.organization.findFirst).toHaveBeenCalledTimes(1);
    });

    it('should return null when organization with clerk id does not exist', async () => {
      const clerkId = 'clerk_nonexistent';

      (dbService.client.organization.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.findOneByClerkId(clerkId);

      expect(result).toBeNull();
      expect(dbService.client.organization.findFirst).toHaveBeenCalledWith({ where: { clerkId } });
    });

    it('should handle clerk IDs with special characters', async () => {
      const clerkId = 'clerk_org_with-special.chars_123';

      (dbService.client.organization.findFirst as jest.Mock).mockResolvedValue(null);

      await service.findOneByClerkId(clerkId);

      expect(dbService.client.organization.findFirst).toHaveBeenCalledWith({
        where: { clerkId: 'clerk_org_with-special.chars_123' },
      });
    });

    it('should handle database errors', async () => {
      const clerkId = 'clerk_org_123';
      const dbError = new Error('Database query timeout');

      (dbService.client.organization.findFirst as jest.Mock).mockRejectedValue(dbError);

      await expect(service.findOneByClerkId(clerkId)).rejects.toThrow('Database query timeout');
    });
  });

  describe('list', () => {
    const createMockOrganization = (id: string, name: string): Organization => ({
      id: id as OrganizationId,
      name,
      clerkId: `clerk_${id}`,
      deleted: false,
      createdAt: new Date('2025-01-01'),
      updatedAt: new Date('2025-01-01'),
    });

    it('should list organizations with default limit', async () => {
      const mockOrganizations: Organization[] = [
        createMockOrganization('org_1', 'Org 1'),
        createMockOrganization('org_2', 'Org 2'),
        createMockOrganization('org_3', 'Org 3'),
      ];

      (dbService.client.organization.findMany as jest.Mock).mockResolvedValue(mockOrganizations);

      const result = await service.list(undefined, undefined);

      expect(result.organizations).toEqual(mockOrganizations);
      expect(result.nextCursor).toBeUndefined();
      expect(dbService.client.organization.findMany).toHaveBeenCalledWith({
        take: 11, // limit + 1
        cursor: undefined,
        orderBy: { id: 'asc' },
      });
    });

    it('should list organizations with custom limit', async () => {
      const mockOrganizations: Organization[] = [
        createMockOrganization('org_1', 'Org 1'),
        createMockOrganization('org_2', 'Org 2'),
      ];

      (dbService.client.organization.findMany as jest.Mock).mockResolvedValue(mockOrganizations);

      const result = await service.list(5, undefined);

      expect(result.organizations).toEqual(mockOrganizations);
      expect(result.nextCursor).toBeUndefined();
      expect(dbService.client.organization.findMany).toHaveBeenCalledWith({
        take: 6, // limit + 1
        cursor: undefined,
        orderBy: { id: 'asc' },
      });
    });

    it('should return nextCursor when more results exist', async () => {
      // Return limit + 1 items to indicate there are more
      const mockOrganizations: Organization[] = [
        createMockOrganization('org_1', 'Org 1'),
        createMockOrganization('org_2', 'Org 2'),
        createMockOrganization('org_3', 'Org 3'),
      ];

      (dbService.client.organization.findMany as jest.Mock).mockResolvedValue(mockOrganizations);

      const result = await service.list(2, undefined);

      expect(result.organizations).toHaveLength(2);
      expect(result.nextCursor).toBe('org_3');
      expect(result.organizations[0].id).toBe('org_1');
      expect(result.organizations[1].id).toBe('org_2');
    });

    it('should use cursor for pagination', async () => {
      const cursor = 'org_5';
      const mockOrganizations: Organization[] = [
        createMockOrganization('org_6', 'Org 6'),
        createMockOrganization('org_7', 'Org 7'),
      ];

      (dbService.client.organization.findMany as jest.Mock).mockResolvedValue(mockOrganizations);

      const result = await service.list(10, cursor);

      expect(result.organizations).toEqual(mockOrganizations);
      expect(dbService.client.organization.findMany).toHaveBeenCalledWith({
        take: 11,
        cursor: { id: cursor },
        orderBy: { id: 'asc' },
      });
    });

    it('should return empty array when no organizations exist', async () => {
      (dbService.client.organization.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.list(undefined, undefined);

      expect(result.organizations).toEqual([]);
      expect(result.nextCursor).toBeUndefined();
    });

    it('should handle exactly limit results without nextCursor', async () => {
      const mockOrganizations: Organization[] = [
        createMockOrganization('org_1', 'Org 1'),
        createMockOrganization('org_2', 'Org 2'),
      ];

      (dbService.client.organization.findMany as jest.Mock).mockResolvedValue(mockOrganizations);

      const result = await service.list(2, undefined);

      expect(result.organizations).toHaveLength(2);
      expect(result.nextCursor).toBeUndefined();
    });

    it('should order results by id ascending', async () => {
      const mockOrganizations: Organization[] = [
        createMockOrganization('org_1', 'Org 1'),
        createMockOrganization('org_2', 'Org 2'),
      ];

      (dbService.client.organization.findMany as jest.Mock).mockResolvedValue(mockOrganizations);

      await service.list(undefined, undefined);

      expect(dbService.client.organization.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: { id: 'asc' },
        }),
      );
    });

    it('should handle database errors', async () => {
      const dbError = new Error('Database connection lost');

      (dbService.client.organization.findMany as jest.Mock).mockRejectedValue(dbError);

      await expect(service.list(undefined, undefined)).rejects.toThrow('Database connection lost');
    });

    it('should handle limit of 1 correctly', async () => {
      const mockOrganizations: Organization[] = [
        createMockOrganization('org_1', 'Org 1'),
        createMockOrganization('org_2', 'Org 2'),
      ];

      (dbService.client.organization.findMany as jest.Mock).mockResolvedValue(mockOrganizations);

      const result = await service.list(1, undefined);

      expect(result.organizations).toHaveLength(1);
      expect(result.nextCursor).toBe('org_2');
      expect(dbService.client.organization.findMany).toHaveBeenCalledWith({
        take: 2,
        cursor: undefined,
        orderBy: { id: 'asc' },
      });
    });

    it('should handle very large limit values', async () => {
      const mockOrganizations: Organization[] = [
        createMockOrganization('org_1', 'Org 1'),
        createMockOrganization('org_2', 'Org 2'),
      ];

      (dbService.client.organization.findMany as jest.Mock).mockResolvedValue(mockOrganizations);

      const result = await service.list(1000, undefined);

      expect(result.organizations).toHaveLength(2);
      expect(result.nextCursor).toBeUndefined();
      expect(dbService.client.organization.findMany).toHaveBeenCalledWith({
        take: 1001,
        cursor: undefined,
        orderBy: { id: 'asc' },
      });
    });
  });
});
