import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';

const prisma = new PrismaClient();

async function main() {
  const orgId = 'org_' + nanoid();
  const userId = 'usr_' + nanoid();
  const tokenId = 'tok_' + nanoid();
  const token = 'test-token-' + nanoid();

  await prisma.organization.create({
    data: {
      id: orgId,
      name: 'Test Org',
      clerkId: 'clerk_' + nanoid(),
    },
  });

  await prisma.user.create({
    data: {
      id: userId,
      organizationId: orgId,
      email: 'test@example.com',
      role: 'ADMIN',
      clerkId: 'clerk_' + nanoid(),
      apiTokens: {
        create: {
          id: tokenId,
          token: token,
          type: 'USER',
          expiresAt: new Date('2099-01-01'),
        },
      },
    },
  });

  console.log(`USER_ID=${userId}`);
  console.log(`API_TOKEN=${token}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
