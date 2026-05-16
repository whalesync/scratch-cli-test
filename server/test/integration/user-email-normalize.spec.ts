import { PrismaClient, UserRole } from '@prisma/client';
import { createOrganizationId, createUserId } from '@spinner/shared-types';

describe('User.email normalization trigger', () => {
  let prisma: PrismaClient;
  const cleanupUserIds: string[] = [];
  const cleanupOrgIds: string[] = [];

  beforeAll(() => {
    prisma = new PrismaClient();
  });

  afterAll(async () => {
    if (cleanupUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: cleanupUserIds } } });
    }
    if (cleanupOrgIds.length > 0) {
      await prisma.organization.deleteMany({ where: { id: { in: cleanupOrgIds } } });
    }
    await prisma.$disconnect();
  });

  const createTestUser = async (email: string | null) => {
    const userId = createUserId();
    const orgId = createOrganizationId();
    cleanupUserIds.push(userId);
    cleanupOrgIds.push(orgId);

    return prisma.user.create({
      data: {
        id: userId,
        updatedAt: new Date(),
        role: UserRole.USER,
        email,
        organization: { create: { id: orgId, name: 'Test Org', clerkId: `clerk-${orgId}` } },
      },
    });
  };

  it('lowercases and trims email on INSERT', async () => {
    const user = await createTestUser('  Foo+Bar@Example.COM  ');
    expect(user.email).toBe('foo+bar@example.com');
  });

  it('lowercases and trims email on UPDATE', async () => {
    const user = await createTestUser('initial@example.com');
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { email: '  CHANGED@Example.COM  ' },
    });
    expect(updated.email).toBe('changed@example.com');
  });

  it('preserves NULL email', async () => {
    const user = await createTestUser(null);
    expect(user.email).toBeNull();
  });

  it('rejects case-different duplicate emails with unique constraint', async () => {
    await createTestUser('dup@example.com');
    await expect(createTestUser('DUP@Example.COM')).rejects.toThrow(/Unique constraint|User_email_key/);
  });
});
