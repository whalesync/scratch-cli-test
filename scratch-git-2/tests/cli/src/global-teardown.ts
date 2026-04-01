import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_FILE = path.join(os.tmpdir(), "scratch-cli-tests-state.json");

export default async function globalTeardown() {
  if (!fs.existsSync(STATE_FILE)) return;

  const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
  fs.unlinkSync(STATE_FILE);

  // Clean up temp HOME with credentials
  if (state.tempHome) {
    try {
      fs.rmSync(state.tempHome, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}
