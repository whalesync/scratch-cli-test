import crypto from "node:crypto";
import { ScratchCli } from "./cli";

let counter = 0;

/** Connector service name for database tests. Defaults to SUPABASE. */
export const TEST_CONNECTOR_SERVICE =
  process.env.TEST_CONNECTOR_SERVICE || "POSTGRES";

/** Generate a unique name for test isolation */
export function uniqueName(prefix = "cli-test"): string {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `${prefix}-${ts}-${rand}-${counter++}`;
}

/**
 * Delete a workspace, used in afterAll/afterEach cleanup.
 * Logs failures but does not throw.
 */
export function deleteWorkspace(cli: ScratchCli, workspaceId: string): void {
  try {
    const result = cli.run(["workspaces", "delete", workspaceId, "--yes"], {
      noJson: true,
      expectError: true,
    });
    if (result.exitCode !== 0) {
      console.warn(
        `[cleanup] Failed to delete workspace ${workspaceId}: ${result.stderr || result.stdout}`,
      );
    }
  } catch (err) {
    console.warn(`[cleanup] Failed to delete workspace ${workspaceId}:`, err);
  }
}
