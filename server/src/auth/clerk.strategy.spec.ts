/* eslint-disable @typescript-eslint/unbound-method */
import type { ClerkClient } from '@clerk/backend';
import { verifyToken } from '@clerk/backend';
import { TokenVerificationError, TokenVerificationErrorReason } from '@clerk/backend/errors';
import { UnauthorizedException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { Request } from 'express';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { UserCluster } from 'src/db/cluster-types';
import { WSLogger } from 'src/logger';
import { UsersService } from 'src/users/users.service';
import { ClerkStrategy } from './clerk.strategy';
import { ScratchJwtPayload } from './types';

// Mock the @clerk/backend module
jest.mock('@clerk/backend', () => ({
  verifyToken: jest.fn(),
}));

describe('ClerkStrategy', () => {
  let strategy: ClerkStrategy;
  let usersService: jest.Mocked<UsersService>;
  let configService: jest.Mocked<ScratchConfigService>;
  let loggerErrorSpy: jest.SpyInstance;

  const CLERK_SECRET = 'test_clerk_secret_key';

  const mockJwtPayload: ScratchJwtPayload = {
    sub: 'clerk_user_123',
    fullName: 'John Doe',
    primaryEmail: 'john@example.com',
  };

  const mockUser = {
    id: 'user_123',
    clerkId: 'clerk_user_123',
    name: 'John Doe',
    email: 'john@example.com',
    organizationId: 'org_456',
    apiTokens: [],
    workspacePermissions: [],
    organization: null,
  } as unknown as UserCluster.User;

  beforeEach(async () => {
    const mockUsersService = {
      getOrCreateUserFromClerk: jest.fn(),
      findByClerkId: jest.fn(),
    };

    const mockConfigService = {
      getClerkSecretKey: jest.fn().mockReturnValue(CLERK_SECRET),
    };

    const mockClerkClient = {} as jest.Mocked<ClerkClient>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ClerkStrategy,
        {
          provide: UsersService,
          useValue: mockUsersService,
        },
        {
          provide: ScratchConfigService,
          useValue: mockConfigService,
        },
        {
          provide: 'ClerkClient',
          useValue: mockClerkClient,
        },
      ],
    }).compile();

    strategy = module.get<ClerkStrategy>(ClerkStrategy);
    usersService = module.get(UsersService);
    configService = module.get(ScratchConfigService);

    // Clear mocks
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllMocks();
    // Restore WSLogger.error if it was spied on
    if (loggerErrorSpy) {
      loggerErrorSpy.mockRestore();
    }
  });

  describe('validate', () => {
    it('should successfully validate a valid JWT token and return authenticated user', async () => {
      const mockRequest = {
        headers: {
          authorization: 'Bearer valid_jwt_token',
        },
      } as Request;

      (verifyToken as jest.Mock).mockResolvedValue(mockJwtPayload);
      usersService.getOrCreateUserFromClerk.mockResolvedValue(mockUser);

      const result = await strategy.validate(mockRequest);

      expect(result).toEqual({
        ...mockUser,
        authType: 'jwt',
        authSource: 'user',
      });
      expect(verifyToken).toHaveBeenCalledWith('valid_jwt_token', {
        secretKey: CLERK_SECRET,
      });
      expect(usersService.getOrCreateUserFromClerk).toHaveBeenCalledWith(
        'clerk_user_123',
        'John Doe',
        'john@example.com',
      );
    });

    it('should throw UnauthorizedException when no authorization header is provided', async () => {
      const mockRequest = {
        headers: {},
      } as Request;

      await expect(strategy.validate(mockRequest)).rejects.toThrow(new UnauthorizedException('No token provided'));

      expect(verifyToken).not.toHaveBeenCalled();
      expect(usersService.getOrCreateUserFromClerk).not.toHaveBeenCalled();
    });

    it('should throw UnauthorizedException when authorization header has no Bearer prefix', async () => {
      const mockRequest = {
        headers: {
          authorization: 'Token invalid_format',
        },
      } as Request;

      await expect(strategy.validate(mockRequest)).rejects.toThrow(new UnauthorizedException('No token provided'));

      expect(verifyToken).not.toHaveBeenCalled();
    });

    it('should throw UnauthorizedException when authorization header is malformed', async () => {
      const mockRequest = {
        headers: {
          authorization: 'Bearer',
        },
      } as Request;

      await expect(strategy.validate(mockRequest)).rejects.toThrow(new UnauthorizedException('No token provided'));
    });

    it('should throw UnauthorizedException when JWT verification fails with TokenVerificationError', async () => {
      // Suppress expected error logs from WSLogger
      loggerErrorSpy = jest.spyOn(WSLogger, 'error').mockImplementation();

      const mockRequest = {
        headers: {
          authorization: 'Bearer invalid_token',
        },
      } as Request;

      const verificationError = new TokenVerificationError({
        reason: TokenVerificationErrorReason.TokenExpired,
        message: 'Token expired',
      });

      (verifyToken as jest.Mock).mockRejectedValue(verificationError);

      await expect(strategy.validate(mockRequest)).rejects.toThrow(new UnauthorizedException('Invalid JWT token'));

      expect(usersService.getOrCreateUserFromClerk).not.toHaveBeenCalled();
    });

    it('should throw UnauthorizedException when JWT verification fails with generic error', async () => {
      // Suppress expected error logs from WSLogger
      loggerErrorSpy = jest.spyOn(WSLogger, 'error').mockImplementation();

      const mockRequest = {
        headers: {
          authorization: 'Bearer invalid_token',
        },
      } as Request;

      (verifyToken as jest.Mock).mockRejectedValue(new Error('Generic verification error'));

      await expect(strategy.validate(mockRequest)).rejects.toThrow(new UnauthorizedException('Invalid JWT token'));
    });

    it('should throw UnauthorizedException when user creation/retrieval fails', async () => {
      // Suppress expected error logs from WSLogger
      loggerErrorSpy = jest.spyOn(WSLogger, 'error').mockImplementation();

      const mockRequest = {
        headers: {
          authorization: 'Bearer valid_jwt_token',
        },
      } as Request;

      (verifyToken as jest.Mock).mockResolvedValue(mockJwtPayload);
      usersService.getOrCreateUserFromClerk.mockRejectedValue(new Error('Database error'));

      await expect(strategy.validate(mockRequest)).rejects.toThrow(new UnauthorizedException('Error loading user'));
    });

    it('should throw UnauthorizedException when user is not found', async () => {
      const mockRequest = {
        headers: {
          authorization: 'Bearer valid_jwt_token',
        },
      } as Request;

      (verifyToken as jest.Mock).mockResolvedValue(mockJwtPayload);
      usersService.getOrCreateUserFromClerk.mockResolvedValue(null);

      await expect(strategy.validate(mockRequest)).rejects.toThrow(new UnauthorizedException('No Scratch user found'));
    });

    it('should handle JWT payload without optional fields (fullName, primaryEmail)', async () => {
      const mockRequest = {
        headers: {
          authorization: 'Bearer valid_jwt_token',
        },
      } as Request;

      const minimalPayload: ScratchJwtPayload = {
        sub: 'clerk_user_123',
      };

      (verifyToken as jest.Mock).mockResolvedValue(minimalPayload);
      usersService.getOrCreateUserFromClerk.mockResolvedValue(mockUser);

      const result = await strategy.validate(mockRequest);

      expect(result).toEqual({
        ...mockUser,
        authType: 'jwt',
        authSource: 'user',
      });
      expect(usersService.getOrCreateUserFromClerk).toHaveBeenCalledWith('clerk_user_123', undefined, undefined);
    });

    it('should handle user without organization ID', async () => {
      const mockRequest = {
        headers: {
          authorization: 'Bearer valid_jwt_token',
        },
      } as Request;

      const userWithoutOrg: UserCluster.User = {
        ...mockUser,
        organizationId: null,
      };

      (verifyToken as jest.Mock).mockResolvedValue(mockJwtPayload);
      usersService.getOrCreateUserFromClerk.mockResolvedValue(userWithoutOrg);

      const result = await strategy.validate(mockRequest);

      expect(result).toEqual({
        ...userWithoutOrg,
        authType: 'jwt',
        authSource: 'user',
      });
    });

    it('should reject authorization header with leading whitespace', async () => {
      const mockRequest = {
        headers: {
          authorization: '  Bearer   valid_jwt_token  ',
        },
      } as Request;

      // Split on space will create ['', '', 'Bearer', '', '', 'valid_jwt_token', '', '']
      // So parts[0] will be empty string, not 'Bearer'
      await expect(strategy.validate(mockRequest)).rejects.toThrow(new UnauthorizedException('No token provided'));

      expect(verifyToken).not.toHaveBeenCalled();
    });

    it('should preserve all user fields in authenticated user response', async () => {
      const mockRequest = {
        headers: {
          authorization: 'Bearer valid_jwt_token',
        },
      } as Request;

      const userWithAlternateOrg = {
        ...mockUser,
        organizationId: 'org_alternate',
      } as unknown as UserCluster.User;

      (verifyToken as jest.Mock).mockResolvedValue(mockJwtPayload);
      usersService.getOrCreateUserFromClerk.mockResolvedValue(userWithAlternateOrg);

      const result = await strategy.validate(mockRequest);

      expect(result.organizationId).toBe('org_alternate');
      expect(result.authType).toBe('jwt');
      expect(result.authSource).toBe('user');
    });

    it('should use config service to get Clerk secret key', async () => {
      const mockRequest = {
        headers: {
          authorization: 'Bearer valid_jwt_token',
        },
      } as Request;

      (verifyToken as jest.Mock).mockResolvedValue(mockJwtPayload);
      usersService.getOrCreateUserFromClerk.mockResolvedValue(mockUser);

      await strategy.validate(mockRequest);

      expect(configService.getClerkSecretKey).toHaveBeenCalled();
      expect(verifyToken).toHaveBeenCalledWith('valid_jwt_token', {
        secretKey: CLERK_SECRET,
      });
    });

    it('should handle case-sensitive Bearer prefix', async () => {
      const mockRequest = {
        headers: {
          authorization: 'bearer valid_jwt_token',
        },
      } as Request;

      await expect(strategy.validate(mockRequest)).rejects.toThrow(new UnauthorizedException('No token provided'));
    });

    it('should handle very long JWT tokens', async () => {
      const longToken = 'a'.repeat(2000);
      const mockRequest = {
        headers: {
          authorization: `Bearer ${longToken}`,
        },
      } as Request;

      (verifyToken as jest.Mock).mockResolvedValue(mockJwtPayload);
      usersService.getOrCreateUserFromClerk.mockResolvedValue(mockUser);

      const result = await strategy.validate(mockRequest);

      expect(result).toEqual({
        ...mockUser,
        authType: 'jwt',
        authSource: 'user',
      });
      expect(verifyToken).toHaveBeenCalledWith(longToken, {
        secretKey: CLERK_SECRET,
      });
    });

    it('should handle JWT payload with special characters in name and email', async () => {
      const mockRequest = {
        headers: {
          authorization: 'Bearer valid_jwt_token',
        },
      } as Request;

      const specialPayload: ScratchJwtPayload = {
        sub: 'clerk_user_123',
        fullName: "O'Brien-Smith, Jr. 李明",
        primaryEmail: 'user+test@example.co.uk',
      };

      (verifyToken as jest.Mock).mockResolvedValue(specialPayload);
      usersService.getOrCreateUserFromClerk.mockResolvedValue(mockUser);

      await strategy.validate(mockRequest);

      expect(usersService.getOrCreateUserFromClerk).toHaveBeenCalledWith(
        'clerk_user_123',
        "O'Brien-Smith, Jr. 李明",
        'user+test@example.co.uk',
      );
    });
  });

  describe('impersonation (the JWT actor claim)', () => {
    const mockImpersonator = {
      id: 'user_admin_789',
      clerkId: 'clerk_admin_789',
      name: 'Admin Adminson',
      email: 'admin@whalesync.com',
      organizationId: 'org_456',
      apiTokens: [],
      workspacePermissions: [],
      organization: null,
    } as unknown as UserCluster.User;

    const impersonatedJwtPayload: ScratchJwtPayload = {
      ...mockJwtPayload,
      act: { sub: 'clerk_admin_789' },
    };

    const mockRequest = {
      headers: { authorization: 'Bearer valid_jwt_token' },
    } as Request;

    it('resolves the impersonator when the actor claim maps to a Scratch user', async () => {
      (verifyToken as jest.Mock).mockResolvedValue(impersonatedJwtPayload);
      usersService.getOrCreateUserFromClerk.mockResolvedValue(mockUser);
      usersService.findByClerkId.mockResolvedValue(mockImpersonator);

      const result = await strategy.validate(mockRequest);

      // The impersonated user remains the authenticated subject — authorization must still be
      // evaluated against them, not the admin.
      expect(result.id).toBe(mockUser.id);
      expect(result.impersonator).toEqual(mockImpersonator);
      expect(usersService.findByClerkId).toHaveBeenCalledWith('clerk_admin_789');
    });

    it('leaves impersonator undefined when there is no actor claim', async () => {
      (verifyToken as jest.Mock).mockResolvedValue(mockJwtPayload);
      usersService.getOrCreateUserFromClerk.mockResolvedValue(mockUser);

      const result = await strategy.validate(mockRequest);

      expect(result.impersonator).toBeUndefined();
      expect(usersService.findByClerkId).not.toHaveBeenCalled();
    });

    it('warns and does not create a user when the impersonator has no Scratch account', async () => {
      loggerErrorSpy = jest.spyOn(WSLogger, 'warn').mockImplementation(() => undefined);

      (verifyToken as jest.Mock).mockResolvedValue(impersonatedJwtPayload);
      usersService.getOrCreateUserFromClerk.mockResolvedValue(mockUser);
      usersService.findByClerkId.mockResolvedValue(null);

      const result = await strategy.validate(mockRequest);

      // The session still authenticates, but the miss must be loud — an unattributable impersonation
      // is otherwise indistinguishable from an ordinary request.
      expect(result.id).toBe(mockUser.id);
      expect(result.impersonator).toBeUndefined();
      expect(WSLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ impersonatorClerkId: 'clerk_admin_789' }));
      // The impersonator is looked up, never created.
      expect(usersService.getOrCreateUserFromClerk).toHaveBeenCalledTimes(1);
      expect(usersService.getOrCreateUserFromClerk).not.toHaveBeenCalledWith(
        'clerk_admin_789',
        expect.anything(),
        expect.anything(),
      );
    });

    it('does not fail an otherwise-valid session when the impersonator lookup throws', async () => {
      loggerErrorSpy = jest.spyOn(WSLogger, 'error').mockImplementation(() => undefined);

      (verifyToken as jest.Mock).mockResolvedValue(impersonatedJwtPayload);
      usersService.getOrCreateUserFromClerk.mockResolvedValue(mockUser);
      usersService.findByClerkId.mockRejectedValue(new Error('database is down'));

      const result = await strategy.validate(mockRequest);

      expect(result.id).toBe(mockUser.id);
      expect(result.impersonator).toBeUndefined();
      expect(WSLogger.error).toHaveBeenCalledWith(expect.objectContaining({ impersonatorClerkId: 'clerk_admin_789' }));
    });

    it('ignores an agent actor, which is not a human impersonating a user', async () => {
      (verifyToken as jest.Mock).mockResolvedValue({
        ...mockJwtPayload,
        act: { sub: 'clerk_agent_001', type: 'agent' },
      } as ScratchJwtPayload);
      usersService.getOrCreateUserFromClerk.mockResolvedValue(mockUser);

      const result = await strategy.validate(mockRequest);

      expect(result.impersonator).toBeUndefined();
      expect(usersService.findByClerkId).not.toHaveBeenCalled();
    });
  });
});
