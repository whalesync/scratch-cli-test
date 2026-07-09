import { User } from '@prisma/client';
import { ScratchConfigService, ScratchEnvironment } from 'src/config/scratch-config.service';
import { ExperimentsService } from './experiments.service';
import { UserFlag } from './flags';

interface MockPostHogClient {
  isFeatureEnabled: jest.Mock;
  getFeatureFlagPayload: jest.Mock;
  shutdown: jest.Mock;
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

function makeService(environment: ScratchEnvironment): ExperimentsService {
  // No PostHog credentials, so the constructor leaves `posthog` undefined; tests that
  // need PostHog inject a mock client directly onto the instance.
  const configService = {
    getPostHogApiKey: () => undefined,
    getPostHogHost: () => undefined,
    getPosthogFeatureFlagApiKey: () => undefined,
    isProductionEnvironment: () => environment === 'production',
  } as unknown as ScratchConfigService;
  return new ExperimentsService(configService);
}

function injectPostHog(service: ExperimentsService): MockPostHogClient {
  const mockClient: MockPostHogClient = {
    isFeatureEnabled: jest.fn(),
    getFeatureFlagPayload: jest.fn(),
    shutdown: jest.fn(),
  };
  (service as unknown as { posthog: MockPostHogClient }).posthog = mockClient;
  return mockClient;
}

describe('ExperimentsService — ENABLE_SCRATCH_FOLDERS (DEV-10424)', () => {
  it('is ON in development regardless of PostHog (no credentials configured)', async () => {
    const service = makeService('development');

    const flags = await service.resolveClientFeatureFlagsForUser(makeUser());

    expect(flags[UserFlag.ENABLE_SCRATCH_FOLDERS]).toBe(true);
  });

  it('is ON in staging/test', async () => {
    const staging = makeService('staging');
    const test = makeService('test');

    expect((await staging.resolveClientFeatureFlagsForUser(makeUser()))[UserFlag.ENABLE_SCRATCH_FOLDERS]).toBe(true);
    expect((await test.resolveClientFeatureFlagsForUser(makeUser()))[UserFlag.ENABLE_SCRATCH_FOLDERS]).toBe(true);
  });

  it('is OFF in production by default (PostHog disabled → default false)', async () => {
    const service = makeService('production');

    const flags = await service.resolveClientFeatureFlagsForUser(makeUser());

    expect(flags[UserFlag.ENABLE_SCRATCH_FOLDERS]).toBe(false);
  });

  it('in production, falls back to the PostHog flag so it can be switched on without a redeploy', async () => {
    const service = makeService('production');
    const posthog = injectPostHog(service);
    posthog.isFeatureEnabled.mockResolvedValue(true);

    const flags = await service.resolveClientFeatureFlagsForUser(makeUser());

    expect(flags[UserFlag.ENABLE_SCRATCH_FOLDERS]).toBe(true);
    expect(posthog.isFeatureEnabled).toHaveBeenCalledWith(UserFlag.ENABLE_SCRATCH_FOLDERS, 'usr_1');
  });

  it('in production, stays OFF when the PostHog flag is not enabled for the user', async () => {
    const service = makeService('production');
    const posthog = injectPostHog(service);
    posthog.isFeatureEnabled.mockResolvedValue(false);

    const flags = await service.resolveClientFeatureFlagsForUser(makeUser());

    expect(flags[UserFlag.ENABLE_SCRATCH_FOLDERS]).toBe(false);
  });
});

describe('ExperimentsService — DESKTOP_REVIEW_SURFACE_V2 (DEV-10617)', () => {
  it('defaults OFF in every environment when PostHog is disabled (ships dark, no env special-case)', async () => {
    for (const environment of ['development', 'staging', 'test', 'production'] as const) {
      const service = makeService(environment);

      const flags = await service.resolveClientFeatureFlagsForUser(makeUser());

      expect(flags[UserFlag.DESKTOP_REVIEW_SURFACE_V2]).toBe(false);
    }
  });

  it('is per-user PostHog-targetable — ON only when the flag is enabled for the user', async () => {
    const service = makeService('production');
    const posthog = injectPostHog(service);
    posthog.isFeatureEnabled.mockImplementation((flag: UserFlag) => flag === UserFlag.DESKTOP_REVIEW_SURFACE_V2);

    const flags = await service.resolveClientFeatureFlagsForUser(makeUser());

    expect(flags[UserFlag.DESKTOP_REVIEW_SURFACE_V2]).toBe(true);
    expect(posthog.isFeatureEnabled).toHaveBeenCalledWith(UserFlag.DESKTOP_REVIEW_SURFACE_V2, 'usr_1');
  });
});

describe('ExperimentsService — getMinimumSupportedDesktopVersion (DEV-10735)', () => {
  it('returns the trimmed semver string from the flag payload', async () => {
    const service = makeService('production');
    const posthog = injectPostHog(service);
    posthog.getFeatureFlagPayload.mockResolvedValue('  0.2.0  ');

    const result = await service.getMinimumSupportedDesktopVersion(makeUser());

    expect(result).toBe('0.2.0');
    expect(posthog.getFeatureFlagPayload).toHaveBeenCalledWith(UserFlag.MINIMUM_SUPPORTED_DESKTOP_VERSION, 'usr_1');
  });

  it('is undefined when PostHog is disabled (no credentials) — fail-open, never force an upgrade', async () => {
    const service = makeService('production');

    expect(await service.getMinimumSupportedDesktopVersion(makeUser())).toBeUndefined();
  });

  it('is undefined for an empty payload', async () => {
    const service = makeService('production');
    const posthog = injectPostHog(service);
    posthog.getFeatureFlagPayload.mockResolvedValue('');

    expect(await service.getMinimumSupportedDesktopVersion(makeUser())).toBeUndefined();
  });

  it('is undefined for a non-string payload', async () => {
    const service = makeService('production');
    const posthog = injectPostHog(service);
    posthog.getFeatureFlagPayload.mockResolvedValue({ minVersion: '0.2.0' });

    expect(await service.getMinimumSupportedDesktopVersion(makeUser())).toBeUndefined();
  });

  it('is undefined when the flag lookup throws — fail-open on a PostHog outage', async () => {
    const service = makeService('production');
    const posthog = injectPostHog(service);
    posthog.getFeatureFlagPayload.mockRejectedValue(new Error('posthog down'));

    expect(await service.getMinimumSupportedDesktopVersion(makeUser())).toBeUndefined();
  });
});
