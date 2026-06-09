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

  it('flags a Whalesync shadow user with the person properties on identify and the creation event', () => {
    const shadowUser = makeUser({
      id: 'usr_shadow',
      clerkId: 'ws_wsu-123',
      whalesyncUserId: 'wsu-123',
      email: 'shadow@example.com',
    });

    service.identifyNewUser(shadowUser);

    const identifyProps = identifyProperties(mockClient);
    expect(identifyProps.is_whalesync_shadow_user).toBe(true);
    expect(identifyProps.whalesync_user_id).toBe('wsu-123');

    const createdEvent = capturedEvents(mockClient).find((event) => event.event === 'account_user_created');
    expect(createdEvent?.properties.is_whalesync_shadow_user).toBe(true);
    expect(createdEvent?.properties.whalesync_user_id).toBe('wsu-123');
  });

  it('marks a native user as not a shadow user with a null whalesync id', () => {
    service.identifyNewUser(makeUser());

    const identifyProps = identifyProperties(mockClient);
    expect(identifyProps.is_whalesync_shadow_user).toBe(false);
    expect(identifyProps.whalesync_user_id).toBeNull();
  });
});

describe('PostHogService.trackWhalesyncAccountLinked', () => {
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

  it('fires a whalesync_account_linked event carrying the whalesync id and $sets it on the person', () => {
    const adoptedNativeUser = makeUser({ id: 'usr_native', email: 'ada@example.com' });

    service.trackWhalesyncAccountLinked(adoptedNativeUser, 'wsu-123');

    const linkEvent = capturedEvents(mockClient).find((event) => event.event === 'whalesync_account_linked');
    expect(linkEvent).toBeDefined();
    expect(linkEvent?.properties.whalesync_user_id).toBe('wsu-123');
    // The link is also recorded on the person record so it is queryable.
    expect(linkEvent?.properties.$set).toEqual({ whalesync_user_id: 'wsu-123' });
    // Linking is not creation and not re-identification — no identify() call, and the adopted user is
    // NOT reclassified as a shadow user (it stays a real native user for growth analytics).
    expect(mockClient.identify).not.toHaveBeenCalled();
    expect(linkEvent?.properties.is_whalesync_shadow_user).toBeUndefined();
  });
});
