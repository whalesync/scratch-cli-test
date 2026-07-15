// Reset the Attio CRM-cleanup demo (DEV-10438).
//
// Teardown primitive: deletes ALL demo-owned records (companies + people + deals, matched by
// name against the fixtures) from the Attio workspace. Strictly scoped — it never touches
// non-demo records, so it's safe in the shared integration-test workspace.
//
// The full "reset to baseline" is seed.ts (which teardown-then-recreates) — usually run via
// ready.ts. This standalone reset is explicit teardown only (leaves the workspace empty of
// demo data).
//
// Run:  node demos/attio-crm-cleanup/reset.ts

import { fileURLToPath } from 'node:url';
import { teardown_demo_records } from './seed.ts';

async function reset_demo_crm_data(): Promise<void> {
  console.log('== Attio CRM-cleanup demo: reset (teardown only) ==');
  const removed = await teardown_demo_records();
  console.log(`Removed companies=${removed.companies} people=${removed.people} deals=${removed.deals}`);
  console.log('Demo records cleared. Run seed.ts (or ready.ts) to rebuild the flawed baseline.');
}

// Only run when invoked directly (`node reset.ts`), not when imported by another script.
const this_module_is_run_directly = process.argv[1] === fileURLToPath(import.meta.url);
if (this_module_is_run_directly) {
  await reset_demo_crm_data();
}

export { reset_demo_crm_data };
