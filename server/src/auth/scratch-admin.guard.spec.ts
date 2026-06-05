import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { ScratchAdminGuard } from './scratch-admin.guard';

function createMockExecutionContext(headerValue: string | undefined): ExecutionContext {
  const request = {
    header: (name: string): string | undefined => (name === 'X-Scratch-Admin-Token' ? headerValue : undefined),
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function makeGuard(acceptedKeys: string[]): ScratchAdminGuard {
  const configService = { getScratchAdminApiKeys: () => acceptedKeys } as unknown as ScratchConfigService;
  return new ScratchAdminGuard(configService);
}

describe('ScratchAdminGuard', () => {
  it('allows a request presenting the current admin key', () => {
    const guard = makeGuard(['current-secret']);
    const context = createMockExecutionContext('current-secret');
    expect(guard.canActivate(context)).toBe(true);
  });

  it('allows a request presenting the previous admin key (rotation window)', () => {
    const guard = makeGuard(['current-secret', 'previous-secret']);
    const context = createMockExecutionContext('previous-secret');
    expect(guard.canActivate(context)).toBe(true);
  });

  it('rejects a request presenting a wrong token', () => {
    const guard = makeGuard(['current-secret']);
    const context = createMockExecutionContext('wrong-secret');
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects a request with a token of a different length (timing-safe length guard)', () => {
    const guard = makeGuard(['current-secret']);
    const context = createMockExecutionContext('short');
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects a request with no admin token header', () => {
    const guard = makeGuard(['current-secret']);
    const context = createMockExecutionContext(undefined);
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('fails closed when no admin key is configured', () => {
    const guard = makeGuard([]);
    const context = createMockExecutionContext('any-secret');
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});
