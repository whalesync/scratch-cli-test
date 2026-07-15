// Bootstrap the Scratch side of the Attio CRM-cleanup demo (DEV-10438).
//
// Idempotent find-or-create of ONE persistent demo workbook + Attio connection + three linked
// folders (Companies / People / Deals) on the Scratch server, then a full pull of each.
// Re-running reuses everything (no dupes).
//
// Pairs with seed.ts/reset.ts (which seed/reset the Attio SERVICE via the raw API). This file
// only drives the Scratch CLI. No publish happens here — the only publish is the presenter,
// live in Scratch Desktop.
//
// Run:  SCRATCH_URL=<prod-url> node demos/attio-crm-cleanup/bootstrap.ts
// (omit SCRATCH_URL if the installed scratchmd already defaults to prod)
//
// Prereqs: scratchmd on PATH with ATTIO support (DEV-10438 T-CLI), `scratchmd auth login` done
// once, ATTIO_API_KEY in server/.env.integration.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get_attio_api_key } from '../shared/env.ts';
import {
  assert_cli_authenticated,
  find_available_table_id_by_display_name,
  find_or_create_connection,
  find_or_create_linked_folder,
  find_or_create_workbook,
  init_workbook_local_checkout,
  pull_linked_folder_full,
} from '../shared/scratchmd.ts';
import {
  DEMO_ATTIO_CONNECTION_NAME,
  DEMO_COMPANIES_FOLDER_NAME,
  DEMO_DEALS_FOLDER_NAME,
  DEMO_PEOPLE_FOLDER_NAME,
  DEMO_WORKBOOK_NAME,
} from './constants.ts';

// Local working copy the CLI materializes for files/pull operations (gitignored).
const WORKBOOK_LOCAL_CHECKOUT_DIRECTORY = resolve(import.meta.dirname, '..', '.scratch-checkout-attio');

export interface DemoWorkbookTopology {
  workbook_id: string;
  connection_id: string;
  companies_folder_id: string;
  people_folder_id: string;
  deals_folder_id: string;
  checkout_directory: string;
}

// The three Attio objects the demo links. `linked available` returns the object slug as the
// table id (plain, non-composite) keyed by these display names.
const DEMO_FOLDERS: ReadonlyArray<{ display_name: string; folder_name: string }> = [
  { display_name: 'Companies', folder_name: DEMO_COMPANIES_FOLDER_NAME },
  { display_name: 'People', folder_name: DEMO_PEOPLE_FOLDER_NAME },
  { display_name: 'Deals', folder_name: DEMO_DEALS_FOLDER_NAME },
];

// Ensure the workbook + connection + three linked folders + local checkout all exist.
// Idempotent; does NOT pull.
export function ensure_demo_workbook_topology(): DemoWorkbookTopology {
  assert_cli_authenticated();

  const workbook = find_or_create_workbook(DEMO_WORKBOOK_NAME);
  console.log(`Workbook: ${workbook.name} (${workbook.id})`);

  const connection = find_or_create_connection(workbook.id, 'ATTIO', DEMO_ATTIO_CONNECTION_NAME, {
    apiKey: get_attio_api_key(),
  });
  console.log(`Connection: ${connection.displayName} (${connection.id})`);

  const folder_ids: Record<string, string> = {};
  for (const { display_name, folder_name } of DEMO_FOLDERS) {
    const table_id = find_available_table_id_by_display_name(workbook.id, connection.id, display_name);
    const folder = find_or_create_linked_folder(workbook.id, connection.id, table_id, folder_name);
    folder_ids[folder_name] = folder.id;
    console.log(`Linked folder: ${folder.name} (${folder.id})`);
  }

  // Materialize (and register) the local checkout so `linked pull` has a download target.
  init_workbook_local_checkout(workbook.id, WORKBOOK_LOCAL_CHECKOUT_DIRECTORY);
  console.log(`Local checkout: ${WORKBOOK_LOCAL_CHECKOUT_DIRECTORY}`);

  return {
    workbook_id: workbook.id,
    connection_id: connection.id,
    companies_folder_id: folder_ids[DEMO_COMPANIES_FOLDER_NAME],
    people_folder_id: folder_ids[DEMO_PEOPLE_FOLDER_NAME],
    deals_folder_id: folder_ids[DEMO_DEALS_FOLDER_NAME],
    checkout_directory: WORKBOOK_LOCAL_CHECKOUT_DIRECTORY,
  };
}

function pull_all_folders(topology: DemoWorkbookTopology): void {
  for (const folder_id of [topology.companies_folder_id, topology.people_folder_id, topology.deals_folder_id]) {
    pull_linked_folder_full(topology.workbook_id, folder_id);
  }
}

// First-time / ensure-pulled: topology + full pull of all three folders.
export function bootstrap_attio_demo(): DemoWorkbookTopology {
  console.log('== Bootstrapping Attio CRM-cleanup demo (Scratch side) ==\n');
  const topology = ensure_demo_workbook_topology();
  console.log('Pulling (full) Companies, People, Deals...');
  pull_all_folders(topology);
  console.log(`\nBootstrap complete. Open "${DEMO_WORKBOOK_NAME}" in Scratch Desktop.`);
  return topology;
}

// Reset the WORKBOOK back to the pulled baseline: re-pull so records match the freshly-seeded
// service. (The Attio SERVICE is reset separately by seed.ts/reset.ts; run that first.) We
// never edit via the CLI, so the checkout stays clean and the pull never refuses.
export function reset_demo_workbook_to_baseline(): DemoWorkbookTopology {
  const topology = ensure_demo_workbook_topology();
  console.log('Re-pulling (full) Companies, People, Deals into the workbook...');
  pull_all_folders(topology);
  return topology;
}

const this_module_is_run_directly = process.argv[1] === fileURLToPath(import.meta.url);
if (this_module_is_run_directly) {
  bootstrap_attio_demo();
}
