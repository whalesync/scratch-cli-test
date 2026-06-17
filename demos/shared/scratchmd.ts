// Thin wrapper around the `scratchmd` CLI for the demo tooling (DEV-10438).
//
// Commands + flags here were verified against the CLI source (scratch-git-2/src/cli).
// Workspace context: `auth` and `workspaces` are global. Workbook-scoped groups (connections,
// linked) take a group-level `--workspace <id>` flag placed BETWEEN the group and the action
// (e.g. `connections --workspace <id> list`) — cwd-independent. (`files` has no such flag and
// auto-detects from a checkout; we don't use `files` here.)
//
// Server URL: set SCRATCH_URL to point at prod (e.g. the prod app/api URL). If unset, the
// installed scratchmd uses its own compiled default. Binary path overridable via SCRATCHMD_BIN.
//
// NOTE: this is not yet run-tested against a live Scratch server — see plan T1.4/T1.8. The
// command shapes are verified; the exact cwd binding for `files`/`pull` is the thing to
// confirm on first real run.

import { spawnSync } from 'node:child_process';

const SCRATCHMD_BINARY = process.env.SCRATCHMD_BIN || 'scratchmd';
const SCRATCH_SERVER_URL = process.env.SCRATCH_URL; // optional; CLI default used if unset

function build_global_prefix_args(): string[] {
  return SCRATCH_SERVER_URL ? ['--scratch-url', SCRATCH_SERVER_URL] : [];
}

interface RunScratchmdOptions {
  cwd?: string;
  expect_json?: boolean;
  allow_nonzero_exit?: boolean;
}

interface RunScratchmdResult {
  exit_code: number;
  stdout: string;
  stderr: string;
  json?: any;
}

function run_scratchmd(command_args: string[], options: RunScratchmdOptions = {}): RunScratchmdResult {
  const full_args = [...build_global_prefix_args(), ...command_args];
  const spawn_result = spawnSync(SCRATCHMD_BINARY, full_args, {
    cwd: options.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (spawn_result.error) {
    throw new Error(
      `Could not run "${SCRATCHMD_BINARY}" (${spawn_result.error.message}). ` +
        `Is the scratchmd CLI on PATH? Override with SCRATCHMD_BIN=/path/to/scratchmd.`,
    );
  }

  const exit_code = spawn_result.status ?? 1;
  const stdout = spawn_result.stdout ?? '';
  const stderr = spawn_result.stderr ?? '';

  if (exit_code !== 0 && !options.allow_nonzero_exit) {
    throw new Error(`scratchmd ${command_args.join(' ')} exited ${exit_code}\n${stderr || stdout}`);
  }

  const result: RunScratchmdResult = { exit_code, stdout, stderr };
  if (options.expect_json && exit_code === 0) {
    try {
      result.json = JSON.parse(stdout);
    } catch {
      throw new Error(`Expected JSON from \`scratchmd ${command_args.join(' ')}\` but got:\n${stdout}`);
    }
  }
  return result;
}

// ---- Auth ----

export function is_cli_authenticated(): boolean {
  // `auth status` exits non-zero when not logged in (no --json).
  const result = run_scratchmd(['auth', 'status'], { allow_nonzero_exit: true });
  return result.exit_code === 0;
}

export function assert_cli_authenticated(): void {
  if (!is_cli_authenticated()) {
    throw new Error(
      'scratchmd is not logged in. Run `scratchmd auth login` (one-time) against the demo server first.' +
        (SCRATCH_SERVER_URL ? ` (SCRATCH_URL=${SCRATCH_SERVER_URL})` : ''),
    );
  }
}

// ---- Workbooks ----

export interface WorkbookSummary {
  id: string;
  name: string;
}

export function find_workbook_by_name(workbook_name: string): WorkbookSummary | undefined {
  const result = run_scratchmd(['workspaces', 'list', '--json'], { expect_json: true });
  const workbooks = (result.json?.workbooks ?? []) as WorkbookSummary[];
  return workbooks.find((workbook) => workbook.name === workbook_name);
}

export function create_workbook(workbook_name: string): WorkbookSummary {
  const result = run_scratchmd(['workspaces', 'create', workbook_name, '--json'], { expect_json: true });
  return result.json as WorkbookSummary;
}

export function find_or_create_workbook(workbook_name: string): WorkbookSummary {
  return find_workbook_by_name(workbook_name) ?? create_workbook(workbook_name);
}

export function init_workbook_local_checkout(workbook_id: string, output_directory: string): void {
  run_scratchmd(['workspaces', 'init', workbook_id, '--output', output_directory, '--force']);
}

// ---- Connections ----

export interface ConnectionSummary {
  id: string;
  service: string;
  displayName: string;
}

// Workbook-scoped commands take a group-level `--workspace <id>` flag placed BETWEEN the
// group and the action (e.g. `connections --workspace <id> list`). This is cwd-independent —
// no workspace marker / checkout needed for connections + linked metadata calls.

export function find_connection(
  workbook_id: string,
  display_name: string,
  service: string,
): ConnectionSummary | undefined {
  const result = run_scratchmd(['connections', '--workspace', workbook_id, 'list', '--json'], {
    expect_json: true,
  });
  const connections = (result.json ?? []) as ConnectionSummary[];
  return connections.find((connection) => connection.displayName === display_name && connection.service === service);
}

export function create_connection(
  workbook_id: string,
  service: string,
  display_name: string,
  parameters: Record<string, string>,
): ConnectionSummary {
  const parameter_args = Object.entries(parameters).flatMap(([key, value]) => ['--param', `${key}=${value}`]);
  const result = run_scratchmd(
    ['connections', '--workspace', workbook_id, 'add', '--service', service, '--name', display_name, ...parameter_args, '--json'],
    { expect_json: true },
  );
  return result.json as ConnectionSummary;
}

export function find_or_create_connection(
  workbook_id: string,
  service: string,
  display_name: string,
  parameters: Record<string, string>,
): ConnectionSummary {
  return (
    find_connection(workbook_id, display_name, service) ??
    create_connection(workbook_id, service, display_name, parameters)
  );
}

// ---- Linked folders / available tables ----

export interface AvailableTablePreview {
  id: string;
  displayName: string;
}

export function find_available_table_id_by_display_name(
  workbook_id: string,
  connection_id: string,
  table_display_name: string,
): string {
  const result = run_scratchmd(['linked', '--workspace', workbook_id, 'available', connection_id, '--json'], {
    expect_json: true,
  });
  if (result.json?.discoveryMode === 'SEARCH') {
    throw new Error(
      `Connection ${connection_id} uses SEARCH discovery; cannot list tables directly. (Not expected for Webflow.)`,
    );
  }
  const tables = (result.json ?? []) as AvailableTablePreview[];
  const matched = tables.find((table) => table.displayName === table_display_name);
  if (!matched) {
    throw new Error(
      `No available table named "${table_display_name}" on connection ${connection_id}. Found: ${tables
        .map((table) => table.displayName)
        .join(', ')}`,
    );
  }
  return matched.id;
}

export interface LinkedFolderSummary {
  id: string;
  name: string;
}

export function find_linked_folder(
  workbook_id: string,
  folder_name: string,
): LinkedFolderSummary | undefined {
  const result = run_scratchmd(['linked', '--workspace', workbook_id, 'list', '--json'], { expect_json: true });
  const groups = (result.json ?? []) as Array<{ dataFolders?: LinkedFolderSummary[] }>;
  for (const group of groups) {
    const matched = (group.dataFolders ?? []).find((folder) => folder.name === folder_name);
    if (matched) return matched;
  }
  return undefined;
}

export function create_linked_folder(
  workbook_id: string,
  connection_id: string,
  table_id: string,
  folder_name: string,
): LinkedFolderSummary {
  // The available-table id can be a comma-joined composite (Webflow returns "siteId,collectionId").
  // `--table-id` is repeatable; pass each part separately so the server receives tableId as an
  // array (it destructures e.g. collectionId from the 2nd element — a single joined value leaves
  // that undefined and 500s with "Cannot read properties of undefined (reading 'startsWith')").
  const table_id_args = table_id
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .flatMap((part) => ['--table-id', part]);
  const result = run_scratchmd(
    ['linked', '--workspace', workbook_id, 'add', '--connection-id', connection_id, ...table_id_args, '--name', folder_name, '--json'],
    { expect_json: true },
  );
  return result.json as LinkedFolderSummary;
}

export function find_or_create_linked_folder(
  workbook_id: string,
  connection_id: string,
  table_id: string,
  folder_name: string,
): LinkedFolderSummary {
  return (
    find_linked_folder(workbook_id, folder_name) ??
    create_linked_folder(workbook_id, connection_id, table_id, folder_name)
  );
}

// ---- Pull + workbook reset (local-checkout operations: run in the checkout dir) ----

export function pull_linked_folder_full(workbook_id: string, folder_id: string): void {
  // `linked pull` auto-polls the server pull job (no --no-wait) and downloads into the
  // workbook's local checkout (registered by `workspaces init`). The SERVER-SIDE pull is
  // what Scratch Desktop reads; the local download is just the CLI's own copy.
  run_scratchmd(['linked', '--workspace', workbook_id, 'pull', folder_id, '--mode', 'full']);
}
