/**
 * Mints a Clerk actor token so impersonation can be exercised against a local/dev Clerk instance,
 * and prints the decoded JWT claims of the resulting session token so you can confirm exactly which
 * claim key Clerk emits the actor under (we expect `act` — see ScratchJwtPayload in src/auth/types.ts).
 *
 * Signing in with the printed URL starts a session as `--user` in which `--impersonator` is the actor.
 *
 * Usage (from the repo root):
 *
 *   node --env-file=server/.env -r ts-node/register -r tsconfig-paths/register \
 *     server/scripts/create-clerk-actor-token.ts \
 *     --impersonator user_<clerk id of the staff member> \
 *     [--user user_<clerk id of the user to impersonate>] \
 *     [--expires-in-seconds 3600]
 *
 * With no --user, the first user in the Clerk instance is impersonated. Reads CLERK_SECRET_KEY from
 * the environment; point it at a development instance's key, never production.
 */
import { createClerkClient } from '@clerk/backend';

interface ActorTokenScriptArguments {
  impersonator_clerk_user_id: string;
  user_clerk_user_id_to_impersonate: string | undefined;
  expires_in_seconds: number | undefined;
}

function parseCommandLineArguments(argv: string[]): ActorTokenScriptArguments {
  const flag_to_value_map = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) {
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Flag ${argument} requires a value`);
    }
    flag_to_value_map.set(argument.slice(2), value);
    index += 1;
  }

  const impersonator_clerk_user_id = flag_to_value_map.get('impersonator');
  if (!impersonator_clerk_user_id) {
    throw new Error('Missing required flag --impersonator <clerk user id of the acting staff member>');
  }

  const expires_in_seconds_raw = flag_to_value_map.get('expires-in-seconds');
  const expires_in_seconds = expires_in_seconds_raw === undefined ? undefined : Number(expires_in_seconds_raw);
  if (expires_in_seconds !== undefined && !Number.isFinite(expires_in_seconds)) {
    throw new Error(`--expires-in-seconds must be a number, got "${expires_in_seconds_raw}"`);
  }

  return {
    impersonator_clerk_user_id,
    user_clerk_user_id_to_impersonate: flag_to_value_map.get('user'),
    expires_in_seconds,
  };
}

/**
 * Decodes (does NOT verify) the payload of a JWT so we can show which claims Clerk actually emitted.
 * The server verifies for real via `verifyToken`; here we only want to look at the shape.
 */
function decodeJwtPayloadWithoutVerifying(jwt: string): Record<string, unknown> {
  const payload_segment = jwt.split('.')[1];
  if (!payload_segment) {
    throw new Error('Token is not a JWT — expected three dot-separated segments');
  }
  return JSON.parse(Buffer.from(payload_segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const script_arguments = parseCommandLineArguments(process.argv.slice(2));

  const clerk_secret_key = process.env.CLERK_SECRET_KEY;
  if (!clerk_secret_key) {
    throw new Error('CLERK_SECRET_KEY is not set — pass --env-file=server/.env or export it');
  }
  if (!clerk_secret_key.startsWith('sk_test_')) {
    throw new Error(
      'CLERK_SECRET_KEY is not a development key (expected an sk_test_ prefix). Refusing to mint an ' +
        'actor token against a live Clerk instance.',
    );
  }

  const clerk_client = createClerkClient({ secretKey: clerk_secret_key });

  let user_clerk_user_id_to_impersonate = script_arguments.user_clerk_user_id_to_impersonate;
  if (!user_clerk_user_id_to_impersonate) {
    const first_user_page = await clerk_client.users.getUserList({ limit: 1 });
    const first_user_in_instance = first_user_page.data[0];
    if (!first_user_in_instance) {
      throw new Error('No users exist in this Clerk instance — pass --user explicitly');
    }
    user_clerk_user_id_to_impersonate = first_user_in_instance.id;
    console.log(
      `No --user given; impersonating the first user in the instance: ${user_clerk_user_id_to_impersonate} ` +
        `(${first_user_in_instance.primaryEmailAddress?.emailAddress ?? 'no primary email'})`,
    );
  }

  const actor_token = await clerk_client.actorTokens.create({
    userId: user_clerk_user_id_to_impersonate,
    actor: { sub: script_arguments.impersonator_clerk_user_id },
    expiresInSeconds: script_arguments.expires_in_seconds,
  });

  console.log('');
  console.log(`Actor token created: ${actor_token.id} (status: ${actor_token.status})`);
  console.log(`  impersonated user: ${user_clerk_user_id_to_impersonate}`);
  console.log(`  actor (impersonator): ${script_arguments.impersonator_clerk_user_id}`);
  console.log('');

  if (actor_token.url) {
    console.log('Open this URL to start an impersonated session in the app:');
    console.log(`  ${actor_token.url}`);
    console.log('');
  }

  if (actor_token.token) {
    console.log('Actor token (a sign-in ticket, NOT a session JWT — exchange it by opening the URL above):');
    console.log(`  ${actor_token.token}`);
    console.log('');

    // The actor token is itself a JWT carrying the actor payload, so we can confirm the claim shape
    // without completing a sign-in. The session JWT minted after sign-in carries the same actor.
    try {
      const decoded_actor_token_claims = decodeJwtPayloadWithoutVerifying(actor_token.token);
      console.log('Decoded actor token claims:');
      console.log(JSON.stringify(decoded_actor_token_claims, null, 2));
      console.log('');
      console.log(
        `Actor claim key present as "act": ${Object.prototype.hasOwnProperty.call(decoded_actor_token_claims, 'act')}`,
      );
    } catch (error) {
      console.log(`Could not decode the actor token as a JWT: ${String(error)}`);
    }
  }

  console.log('');
  console.log(
    'To confirm the SESSION token shape (what ClerkStrategy actually verifies), sign in via the URL ' +
      'above, then in the browser console run: await window.Clerk.session.getToken() — and decode it. ' +
      'It should carry the same actor under `act`.',
  );
  console.log('');
  console.log(`Revoke this token when done: clerk_client.actorTokens.revoke('${actor_token.id}')`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
