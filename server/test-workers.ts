/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { get, post } from 'axios';
import { PublishJobDefinition } from './src/worker/jobs/job-definitions/publish.job';

const BASE_URL = 'http://localhost:3010';

async function testWorkers() {
  console.log('🧪 Testing Worker System...\n');

  try {
    // Test 1: Add two numbers job
    console.log('1️⃣ Testing add two numbers job...');
    const addTwoResponse = await post(`${BASE_URL}/workers/jobs/add-two-numbers`, {
      a: 5,
      b: 10,
    });
    console.log('✅ Add two numbers job queued:', addTwoResponse.data);
    const jobId1 = addTwoResponse.data.jobId;

    // Test 2: Add three numbers job
    console.log('\n2️⃣ Testing add three numbers job...');
    const addThreeResponse = await post(`${BASE_URL}/workers/jobs/add-three-numbers`, {
      a: 1,
      b: 2,
      c: 3,
    });
    console.log('✅ Add three numbers job queued:', addThreeResponse.data);
    const jobId2 = addThreeResponse.data.jobId;

    // Test 3: Publish job
    console.log('\n3️⃣ Testing publish job...');
    const workbookId = 'wkb_123' as const; // Example workbook ID
    const publishJobData: PublishJobDefinition['data'] = {
      workbookId,
      type: 'publish',
      userId: '<your-user-id>',
      pipelineId: 'pipeline-123',
      connectorAccountId: '<your-connector-account-id>',
    };
    const publishResponse = await post(`${BASE_URL}/workers/jobs/publish`, publishJobData);
    console.log('✅ Publish job queued:', publishResponse.data);
    const jobId3 = publishResponse.data.jobId;

    // Test 4: Check queue stats
    console.log('\n4️⃣ Checking queue stats...');
    const statsResponse = await get(`${BASE_URL}/workers/queue/stats`);
    console.log('✅ Queue stats:', statsResponse.data);

    // Test 5: Check job status (wait a bit for processing)
    console.log('\n5️⃣ Checking job statuses...');
    await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait 2 seconds

    const job1Status = await get(`${BASE_URL}/workers/jobs/${jobId1}`);
    console.log('✅ Job 1 status:', job1Status.data);

    const job2Status = await get(`${BASE_URL}/workers/jobs/${jobId2}`);
    console.log('✅ Job 2 status:', job2Status.data);

    const job3Status = await get(`${BASE_URL}/workers/jobs/${jobId3}`);
    console.log('✅ Job 3 status:', job3Status.data);

    console.log('\n🎉 All tests completed successfully!');
  } catch (error: any) {
    console.error('❌ Test failed:', error.response?.data || error.message);
  }
}

void testWorkers();
