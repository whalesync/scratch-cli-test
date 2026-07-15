// One-command "get the demo ready" orchestrator for the Attio CRM-cleanup demo (DEV-10438).
//
// Rebuilds the Attio service to the known flawed baseline (teardown + recreate: duplicate
// clusters, blank industry/location, People + Deals hanging off the loser variants) and
// re-pulls the Scratch workbook so it matches. Run a few minutes before a demo call.
//
// Run:  node demos/attio-crm-cleanup/ready.ts

import { fileURLToPath } from 'node:url';
import { reset_demo_workbook_to_baseline } from './bootstrap.ts';
import { seed_demo_crm_data } from './seed.ts';

async function ready_attio_crm_cleanup_demo(): Promise<void> {
  console.log('== Attio CRM-cleanup demo: get ready ==\n');

  // 1. Rebuild the Attio SERVICE to the flawed baseline (raw API; works without the stack).
  //    seed does a full teardown + recreate, so any prior run's enrich/merge edits are wiped.
  await seed_demo_crm_data();

  // 2. Reset the Scratch WORKBOOK to match: re-pull so records track the fresh baseline (needs
  //    the stack + scratchmd). Set DEMO_SKIP_WORKBOOK_RESET=1 for service-only (dev / no scratchmd).
  if (process.env.DEMO_SKIP_WORKBOOK_RESET === '1') {
    console.log('\nDEMO_SKIP_WORKBOOK_RESET=1 — skipping the Scratch workbook reset (service-only).');
  } else {
    console.log('\n== Resetting the Scratch workbook ==');
    reset_demo_workbook_to_baseline();
  }

  console.log(
    '\nDemo ready: flawed baseline in the service' +
      (process.env.DEMO_SKIP_WORKBOOK_RESET === '1' ? '.' : ' and the workbook.'),
  );
  console.log('Open "Attio CRM Cleanup Demo" in Scratch Desktop.');
}

const this_module_is_run_directly = process.argv[1] === fileURLToPath(import.meta.url);
if (this_module_is_run_directly) {
  await ready_attio_crm_cleanup_demo();
}

export { ready_attio_crm_cleanup_demo };
