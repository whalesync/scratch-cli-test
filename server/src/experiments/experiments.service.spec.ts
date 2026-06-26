import { User } from '@prisma/client';
import { ScratchConfigService, ScratchEnvironment } from 'src/config/scratch-config.service';
import { ExperimentsService } from './experiments.service';
import { UserFlag } from './flags';

interface MockPostHogClient {
  isFeatureEnabled: jest.Mock;
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
  const mockClient: MockPostHogClient = { isFeatureEnabled: jest.fn(), shutdown: jest.fn() };
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
