// Loads credentials from server/.env.integration for the demo tooling.
// We parse the file directly (no dotenv dependency) so /demos stays zero-install.
// Per DEV-10438: the demo reuses the integration-test service accounts.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// env.ts lives at /demos/shared/env.ts, so the repo root is two levels up.
const repo_root_directory = resolve(import.meta.dirname, '..', '..');
const env_integration_file_path = resolve(repo_root_directory, 'server', '.env.integration');

let cached_integration_env_variable_map: Record<string, string> | null = null;

function load_integration_env_file_into_map(): Record<string, string> {
  if (cached_integration_env_variable_map) return cached_integration_env_variable_map;

  let raw_file_contents: string;
  try {
    raw_file_contents = readFileSync(env_integration_file_path, 'utf8');
  } catch (error) {
    throw new Error(
      `Could not read ${env_integration_file_path}. The demo tooling reads credentials from there. (${String(error)})`,
    );
  }

  const parsed_variable_map: Record<string, string> = {};
  for (const line of raw_file_contents.split('\n')) {
    const trimmed_line = line.trim();
    if (!trimmed_line || trimmed_line.startsWith('#')) continue;
    const first_equals_index = trimmed_line.indexOf('=');
    if (first_equals_index === -1) continue;
    const variable_name = trimmed_line.slice(0, first_equals_index).trim();
    let variable_value = trimmed_line.slice(first_equals_index + 1).trim();
    const is_double_quoted = variable_value.startsWith('"') && variable_value.endsWith('"');
    const is_single_quoted = variable_value.startsWith("'") && variable_value.endsWith("'");
    if (is_double_quoted || is_single_quoted) {
      variable_value = variable_value.slice(1, -1);
    }
    parsed_variable_map[variable_name] = variable_value;
  }

  cached_integration_env_variable_map = parsed_variable_map;
  return parsed_variable_map;
}

export function get_required_integration_env_variable(variable_name: string): string {
  // Real process env wins if set, otherwise fall back to the .env.integration file.
  const value_from_process_env = process.env[variable_name];
  const value = value_from_process_env ?? load_integration_env_file_into_map()[variable_name];
  if (!value) {
    throw new Error(`Missing ${variable_name} (looked in process.env and server/.env.integration)`);
  }
  return value;
}

export function get_webflow_api_key(): string {
  return get_required_integration_env_variable('WEBFLOW_API_KEY');
}

export function get_attio_api_key(): string {
  return get_required_integration_env_variable('ATTIO_API_KEY');
}
