/**
 * electron-builder afterSign hook — notarize + staple the macOS app with retries.
 *
 * Why this exists (instead of electron-builder's declarative `mac.notarize: true`):
 * `@electron/notarize` runs `xcrun notarytool submit --wait` exactly once with no
 * per-attempt timeout. Apple's Developer ID Notary Service (and the runner's
 * network path to it) fail transiently — `notarytool` returns an empty/non-JSON
 * result after a few minutes — and that single hiccup fails the whole release job
 * with the opaque message "Failed to notarize via notarytool. Failed with
 * unexpected result:". Those failures clear on retry (verified: the same job,
 * Mac, cert, and credentials succeeded minutes later on the local GitLab runner).
 *
 * This hook owns notarization end-to-end so it can:
 *   - retry the submission with backoff (NOTARIZE_MAX_ATTEMPTS, default 3),
 *   - bound each attempt with a real `notarytool --timeout` (NOTARIZE_TIMEOUT,
 *     default 12m) so a hung submission aborts and retries instead of eating the
 *     job timeout,
 *   - staple the ticket on success (electron-builder no longer staples once
 *     `mac.notarize` is false), and
 *   - dump `notarytool log`/`history` on failure so the cause is in the job log
 *     instead of an empty string.
 *
 * It no-ops for unsigned / ad-hoc local builds (build:mac:unsigned sets
 * CSC_IDENTITY='-') and whenever the Apple credentials aren't all present, so
 * local development packaging is unaffected.
 *
 * Credentials (app-specific-password flow), read from the environment:
 *   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_NOTARIZE_TIMEOUT = '12m'; // passed to `notarytool --timeout`
// Backoff applied BETWEEN attempts (so length is DEFAULT_MAX_ATTEMPTS - 1). The
// last value is reused if there are somehow more gaps than entries.
const DEFAULT_BACKOFF_MS = [30_000, 60_000];

function log(message) {
  console.log(`[notarize] ${message}`);
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function positiveIntegerFromEnv(variableName, fallback) {
  const raw = process.env[variableName];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function truncateForLog(text, maxLength) {
  const trimmed = String(text ?? '').trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}…[truncated]` : trimmed;
}

/**
 * Returns a function that scrubs any of `secrets` out of a string before it is
 * logged, so the app-specific password can never reach the CI log (e.g. via a
 * child_process error message that echoes the full command line).
 */
function makeSecretRedactor(secrets) {
  const presentSecrets = secrets.filter(Boolean);
  return (text) => {
    let out = String(text ?? '');
    for (const secret of presentSecrets) {
      out = out.split(secret).join('***');
    }
    return out;
  };
}

async function runCommand(command, args, options = {}) {
  return execFileAsync(command, args, { maxBuffer: 16 * 1024 * 1024, ...options });
}

/**
 * Run `attemptFn` up to maxAttempts times, sleeping backoffMs[i] between tries.
 * Returns the first success. If every attempt throws, runs onExhausted (best
 * effort) and rethrows the last error. Pure and fully injectable (attemptFn,
 * sleep, onFailedAttempt, onExhausted) so it unit-tests without spawning xcrun.
 */
async function runWithRetries(attemptFn, options = {}) {
  const {
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    backoffMs = DEFAULT_BACKOFF_MS,
    sleep = defaultSleep,
    onFailedAttempt,
    onExhausted,
  } = options;

  let lastError;
  for (let attemptNumber = 1; attemptNumber <= maxAttempts; attemptNumber++) {
    try {
      return await attemptFn(attemptNumber);
    } catch (error) {
      lastError = error;
      if (onFailedAttempt) await onFailedAttempt(error, attemptNumber);
      if (attemptNumber < maxAttempts) {
        const delayMs = backoffMs[attemptNumber - 1] ?? backoffMs[backoffMs.length - 1] ?? 0;
        if (delayMs > 0) {
          log(`waiting ${Math.round(delayMs / 1000)}s before retrying…`);
          await sleep(delayMs);
        }
      }
    }
  }
  if (onExhausted) await onExhausted(lastError);
  throw lastError;
}

function readAppleCredentials() {
  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !appleIdPassword || !teamId) return null;
  return { appleId, appleIdPassword, teamId };
}

function notarytoolAuthArgs(credentials) {
  return [
    '--apple-id',
    credentials.appleId,
    '--password',
    credentials.appleIdPassword,
    '--team-id',
    credentials.teamId,
  ];
}

/**
 * Submit one zip to notarytool and wait (bounded by `timeout`) for the result.
 * Resolves with the submission id on `status: Accepted`; otherwise throws. The
 * thrown error carries `.submissionId` when Apple registered the submission so
 * the caller can pull its per-submission log. Never logs the password.
 */
async function submitNotarizationOnce({ zipPath, credentials, timeout, redact, command = runCommand }) {
  const args = [
    'notarytool',
    'submit',
    zipPath,
    ...notarytoolAuthArgs(credentials),
    '--wait',
    '--timeout',
    timeout,
    '--output-format',
    'json',
  ];

  let stdout;
  try {
    ({ stdout } = await command('xcrun', args));
  } catch (error) {
    // Transport/auth/timeout failure: notarytool exited non-zero. Build the
    // message ONLY from fields that can't contain the password (never
    // error.message / error.cmd, which echo the full command line).
    const exitCode = error && error.code !== undefined ? error.code : 'unknown';
    const detail = redact([error && error.stdout, error && error.stderr].filter(Boolean).join('\n'));
    throw new Error(`xcrun notarytool submit exited with code ${exitCode}${detail ? `\n${detail.trim()}` : ''}`);
  }

  const rawOutput = (stdout || '').trim();
  let parsed;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    // The exact transient we keep hitting: notarytool returned empty/non-JSON.
    throw new Error(`notarytool returned no parseable result (transient notary error). Raw: ${redact(rawOutput)}`);
  }

  if (parsed.status !== 'Accepted') {
    const failure = new Error(`notarization not accepted: status=${parsed.status} id=${parsed.id ?? 'n/a'}`);
    failure.submissionId = parsed.id;
    throw failure;
  }
  return parsed.id;
}

async function dumpSubmissionLog(submissionId, credentials, redact) {
  try {
    const { stdout } = await runCommand('xcrun', ['notarytool', 'log', submissionId, ...notarytoolAuthArgs(credentials)]);
    log(`notarytool log for ${submissionId}:\n${redact(truncateForLog(stdout, 4000))}`);
  } catch (error) {
    log(`could not fetch notarytool log for ${submissionId}: ${redact(error && error.message)}`);
  }
}

async function dumpNotarizationHistory(credentials, redact) {
  try {
    const { stdout } = await runCommand('xcrun', [
      'notarytool',
      'history',
      ...notarytoolAuthArgs(credentials),
      '--output-format',
      'json',
    ]);
    log(`recent notarytool history:\n${redact(truncateForLog(stdout, 4000))}`);
  } catch (error) {
    log(`could not fetch notarytool history: ${redact(error && error.message)}`);
  }
}

async function notarizeHook(context) {
  if (context.electronPlatformName !== 'darwin') return;

  if (process.env.CSC_IDENTITY === '-') {
    log('ad-hoc signing (CSC_IDENTITY="-") — skipping notarization');
    return;
  }

  const credentials = readAppleCredentials();
  if (!credentials) {
    log('APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not all set — skipping notarization (unsigned/local build)');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  if (!fs.existsSync(appPath)) {
    throw new Error(`[notarize] expected a signed app at ${appPath}, but it does not exist`);
  }

  const maxAttempts = positiveIntegerFromEnv('NOTARIZE_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS);
  const timeout = process.env.NOTARIZE_TIMEOUT || DEFAULT_NOTARIZE_TIMEOUT;
  const redact = makeSecretRedactor([credentials.appleIdPassword]);

  // notarytool only accepts a zip/pkg/dmg, not a bare .app — zip exactly the way
  // @electron/notarize does so the bundle is preserved.
  const zipPath = path.join(os.tmpdir(), `scratch-notarize-${appName}-${process.pid}.zip`);
  log(`zipping ${appPath} → ${zipPath}`);
  await runCommand('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath], {
    cwd: path.dirname(appPath),
  });

  try {
    const submissionId = await runWithRetries(
      (attemptNumber) => {
        log(`notarytool submit — attempt ${attemptNumber}/${maxAttempts} (per-attempt timeout ${timeout})`);
        return submitNotarizationOnce({ zipPath, credentials, timeout, redact });
      },
      {
        maxAttempts,
        onFailedAttempt: async (error, attemptNumber) => {
          log(`attempt ${attemptNumber} failed: ${redact(error && error.message)}`);
          if (error && error.submissionId) await dumpSubmissionLog(error.submissionId, credentials, redact);
        },
        onExhausted: async () => {
          log(`all ${maxAttempts} notarization attempts failed`);
          await dumpNotarizationHistory(credentials, redact);
        },
      },
    );
    log(`notarization accepted (submission id ${submissionId})`);
  } finally {
    fs.rmSync(zipPath, { force: true });
  }

  log(`stapling ticket to ${appPath}`);
  await runCommand('xcrun', ['stapler', 'staple', appPath]);
  log('notarization + stapling complete');
}

// electron-builder accepts either `module.exports` being the hook function or a
// `.default` export (afterPack.cjs uses `.default`). Expose both, plus the pure
// helpers for unit tests.
module.exports = notarizeHook;
module.exports.default = notarizeHook;
module.exports.runWithRetries = runWithRetries;
module.exports.submitNotarizationOnce = submitNotarizationOnce;
module.exports.readAppleCredentials = readAppleCredentials;
