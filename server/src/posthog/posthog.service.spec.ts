import { User } from '@prisma/client';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { PostHogService } from './posthog.service';

interface MockPostHogClient {
  identify: jest.Mock;
  capture: jest.Mock;
}

type CapturedProperties = Record<string, unknown>;

// Typed extraction of the mock call arguments (avoids `any` member access).
function identifyProperties(client: MockPostHogClient): CapturedProperties {
  const firstCallArgs = client.identify.mock.calls[0] as unknown[];
  return (firstCallArgs[0] as { properties: CapturedProperties }).properties;
}

function capturedEvents(client: MockPostHogClient): { event: string; properties: CapturedProperties }[] {
  const calls = client.capture.mock.calls as unknown[][];
  return calls.map((call) => call[0] as { event: string; properties: CapturedProperties });
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 'usr_1',
    createdAt: new Date('2026-06-04T00:00:00Z'),
    updatedAt: new Date('2026-06-04T00:00:00Z'),
    clerkId: 'user_native',
    whalesyncUserId: null,
    whalesyncTeamId: null,
    name: 'Native User',
    email: 'native@example.com',
    role: 'USER',
    ...overrides,
  } as unknown as User;
}

describe('PostHogService.identifyNewUser', () => {
  let service: PostHogService;
  let mockClient: MockPostHogClient;

  beforeEach(() => {
    // Config returns no PostHog credentials, so the constructor leaves `postHog` undefined; we inject a
    // mock client directly to exercise identify/capture without a real SDK connection.
    const configService = {
      getPostHogApiKey: () => undefined,
      getPostHogHost: () => undefined,
      isPosthogAnaltyicsEnabled: () => false,
    } as unknown as ScratchConfigService;
    service = new PostHogService(configService);

    mockClient = { identify: jest.fn(), capture: jest.fn() };
    (service as unknown as { postHog: MockPostHogClient }).postHog = mockClient;
  });

  it("flags a Whalesync team's shadow user with the person properties on identify and the creation event", () => {
    const shadowUser = makeUser({
      id: 'usr_shadow',
      clerkId: 'ws_tm_acme',
      whalesyncTeamId: 'tm_acme',
    });

    service.identifyNewUser(shadowUser);

    const identifyProps = identifyProperties(mockClient);
    expect(identifyProps.is_whalesync_shadow_user).toBe(true);
    expect(identifyProps.whalesync_team_id).toBe('tm_acme');
    expect(identifyProps).not.toHaveProperty('whalesync_user_id');

    const createdEvent = capturedEvents(mockClient).find((event) => event.event === 'account_user_created');
    expect(createdEvent?.properties.is_whalesync_shadow_user).toBe(true);
    expect(createdEvent?.properties.whalesync_team_id).toBe('tm_acme');
    expect(createdEvent?.properties).not.toHaveProperty('whalesync_user_id');
  });

  it('keys is_whalesync_shadow_user on the team id, not on a leftover Whalesync person id', () => {
    service.identifyNewUser(makeUser({ clerkId: 'ws_wsu-123', whalesyncUserId: 'wsu-123', whalesyncTeamId: null }));

    expect(identifyProperties(mockClient).is_whalesync_shadow_user).toBe(false);
  });

  it('marks a native user as not a shadow user with a null whalesync team id', () => {
    service.identifyNewUser(makeUser());

    const identifyProps = identifyProperties(mockClient);
    expect(identifyProps.is_whalesync_shadow_user).toBe(false);
    expect(identifyProps.whalesync_team_id).toBeNull();
  });
});

describe('PostHogService.trackClerkAccountLinked', () => {
  let service: PostHogService;
  let mockClient: MockPostHogClient;

  beforeEach(() => {
    const configService = {
      getPostHogApiKey: () => undefined,
      getPostHogHost: () => undefined,
      isPosthogAnaltyicsEnabled: () => false,
    } as unknown as ScratchConfigService;
    service = new PostHogService(configService);

    mockClient = { identify: jest.fn(), capture: jest.fn() };
    (service as unknown as { postHog: MockPostHogClient }).postHog = mockClient;
  });

  it('fires a clerk_account_linked event carrying the real clerk id and the whalesync team id (DEV-10731)', () => {
    // A user created without a Clerk login that just signed in natively for the first time and was adopted.
    const adoptedShadowUser = makeUser({
      id: 'usr_shadow',
      clerkId: 'user_realclerkid',
      whalesyncTeamId: null,
      email: 'ada@example.com',
    });

    service.trackClerkAccountLinked(adoptedShadowUser, 'user_realclerkid');

    const linkEvent = capturedEvents(mockClient).find((event) => event.event === 'clerk_account_linked');
    expect(linkEvent).toBeDefined();
    expect(linkEvent?.properties.clerk_id).toBe('user_realclerkid');
    expect(linkEvent?.properties.whalesync_team_id).toBeNull();
    expect(linkEvent?.properties).not.toHaveProperty('whalesync_user_id');
    // A link, not a creation or re-identification — no identify() call.
    expect(mockClient.identify).not.toHaveBeenCalled();
  });
});
