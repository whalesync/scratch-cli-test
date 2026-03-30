/**
 * Verify that `turbo dev --dry-run=json` runs exactly the expected set of services.
 * If you intentionally added or removed a dev service, update EXPECTED below.
 *
 * Usage: npx turbo dev --dry-run=json | node scripts/verify-turbo-dev.mjs
 */
import { readFileSync } from "fs";

const EXPECTED = [
  "@spinner/shared-types#dev",
  "client#dev",
  "scratch-desktop#dev",
  "scratch-git-2#dev",
  "server#dev",
];

const data = JSON.parse(readFileSync("/dev/stdin", "utf8"));
const actual = data.tasks
  .filter((t) => t.task === "dev" && t.command !== "<NONEXISTENT>")
  .map((t) => t.package + "#" + t.task)
  .sort();

console.log("Expected:", EXPECTED.join(" "));
console.log("Actual:  ", actual.join(" "));

if (JSON.stringify(actual) !== JSON.stringify(EXPECTED)) {
  console.log("FAIL: turbo dev services do not match expected set.");
  console.log(
    "If you added or removed a dev service, update EXPECTED in scripts/verify-turbo-dev.mjs.",
  );
  process.exit(1);
}
console.log("PASS: turbo dev services match expected set.");
