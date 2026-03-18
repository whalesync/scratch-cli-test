import { createClerkClient } from "@clerk/backend";

// Cache for auth token to avoid fetching it multiple times
let cachedAuthToken: string | null = null;
let cachedUserId: string | null = null;

export interface AuthConfig {
  authToken: string;
  userId: string;
}

/**
 * Gets or creates a Clerk auth token for tests.
 * The token is cached unless forceRefresh is true.
 */
export async function getAuthToken(forceRefresh = false): Promise<AuthConfig> {
  if (!forceRefresh && cachedAuthToken && cachedUserId) {
    return { authToken: cachedAuthToken, userId: cachedUserId };
  }

  const clerkSecretKey = process.env.CLERK_SECRET_KEY;
  if (!clerkSecretKey) {
    throw new Error(
      "You need to set this variable to run the tests: CLERK_SECRET_KEY",
    );
  }

  const userId = process.env.INTEGRATION_TEST_USER_ID;
  if (!userId) {
    throw new Error(
      "You need to set this variable to run the tests: INTEGRATION_TEST_USER_ID",
    );
  }

  const clerkClient = createClerkClient({ secretKey: clerkSecretKey });

  // Get an active session for the test user or create one
  const sessions = await clerkClient.sessions.getSessionList({ userId });

  let sessionId: string;
  if (sessions.data.length > 0 && sessions.data[0].status === "active") {
    const session = sessions.data[0];
    sessionId = session.id;
    console.log(`Using existing Clerk session: ${JSON.stringify(session)}`);
  } else {
    const session = await clerkClient.sessions.createSession({
      userId,
    });
    sessionId = session.id;
    console.log(`Created new Clerk session ${sessionId}`);
  }

  // Get the JWT token from the session (using default template)
  const tokenResponse = await clerkClient.sessions.getToken(sessionId, "");

  // Cache the results
  cachedAuthToken = tokenResponse.jwt;
  cachedUserId = userId;

  return { authToken: cachedAuthToken, userId: cachedUserId };
}
