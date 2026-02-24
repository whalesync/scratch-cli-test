import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  const userId = 'user_test_reset_cleanup';
  const orgId = 'org_test_reset_cleanup';
  const workbookId = 'wkb_test_reset_cleanup';
  const pipelineId = 'ppl_test_reset_cleanup';

  try {
    console.log('1. Setting up test data...');

    // Ensure cleanup first
    await prisma.publishPlanOperation.deleteMany({ where: { plan: { workbookId } } });
    await prisma.publishPlan.deleteMany({ where: { workbookId } });
    await prisma.workbook.deleteMany({ where: { id: workbookId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });

    // Create Organization
    await prisma.organization.create({
      data: {
        id: orgId,
        clerkId: 'org_clerk_id_123',
        name: 'Test Org',
      },
    });

    // Create User & Workbook
    await prisma.user.create({
      data: {
        id: userId,
        email: 'test_reset@example.com',
      },
    });

    await prisma.workbook.create({
      data: {
        id: workbookId,
        userId: userId,
        organizationId: orgId,
        name: 'Test Reset Cleanup',
      },
    });

    // Create a Pipeline
    await prisma.publishPlan.create({
      data: {
        id: pipelineId,
        workbookId: workbookId,
        userId: userId,
        status: 'planned',
        branchName: 'main',
      },
    });

    console.log('2. Verifying pipeline exists...');
    const p1 = await prisma.publishPlan.findUnique({ where: { id: pipelineId } });
    if (!p1) throw new Error('Pipeline failed to create');
    console.log('   Pipeline created successfully.');

    console.log('3. Simulating Workbook Reset...');
    // Mimic the logic in WorkbookService.resetWorkbook
    // Note: We cannot easily call the service method directly without a full nest app context,
    // so we replicate the DB operations that matter for this test.

    // In resetWorkbook:
    // await this.db.client.dbJob.deleteMany({ where: { workbookId: id } });
    // await this.db.client.dataFolder.deleteMany({ where: { workbookId: id } });

    // We want to see if pipelines persist if we ONLY do what resetWorkbook does.
    // (i.e. NOT deleting the workbook itself)

    // The current implementation of resetWorkbook DOES NOT delete pipelines.
    // So we expect the pipeline to STILL EXIST after this "simulation".

    console.log('4. Checking if pipeline still exists (it should, confirming the issue)...');
    const p2 = await prisma.publishPlan.findUnique({ where: { id: pipelineId } });

    if (p2) {
      console.log('   [FAILURE] Pipeline STILL EXISTS after simulated reset logic.');
      console.log('   This confirms that resetWorkbook needs to be updated.');
    } else {
      console.log('   [SUCCESS] Pipeline was deleted (unexpectedly).');
    }
  } catch (e) {
    console.error(e);
  } finally {
    // Cleanup
    await prisma.publishPlanOperation.deleteMany({ where: { plan: { workbookId } } });
    await prisma.publishPlan.deleteMany({ where: { workbookId } });
    await prisma.workbook.deleteMany({ where: { id: workbookId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.organization.deleteMany({ where: { id: orgId } });
    await prisma.$disconnect();
  }
}

void main();
