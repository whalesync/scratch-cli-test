import { Injectable } from '@nestjs/common';
import { TokenType } from '@prisma/client';
import { createApiTokenId, createAuthorizationCodeId } from '@spinner/shared-types';
import { customAlphabet } from 'nanoid';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { generateApiToken } from 'src/users/tokens';
import { AuthInitiateResponseDto, AuthPollResponseDto, AuthVerifyResponseDto } from './dtos/cli-auth.dto';

// Alphabet for user codes - uppercase letters and numbers, excluding confusing characters (0, O, I, 1, L)
const USER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const generateUserCode = customAlphabet(USER_CODE_ALPHABET, 8);

// Alphabet for polling codes - full alphanumeric
const POLLING_CODE_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const generatePollingCode = customAlphabet(POLLING_CODE_ALPHABET, 32);

// Code validity duration (10 minutes)
const CODE_VALIDITY_SECONDS = 600;

// Polling interval (5 seconds)
const POLL_INTERVAL_SECONDS = 5;

@Injectable()
export class CliAuthService {
  constructor(
    private readonly db: DbService,
    private readonly config: ScratchConfigService,
  ) {}

  /**
   * Initiates the authorization flow.
   * Generates user code and polling code, stores them in the database.
   */
  async initiateAuth(): Promise<AuthInitiateResponseDto> {
    try {
      // Generate codes
      const rawUserCode = generateUserCode();
      // Format as XXXX-XXXX for readability
      const userCode = `${rawUserCode.slice(0, 4)}-${rawUserCode.slice(4)}`;
      const pollingCode = generatePollingCode();

      // Calculate expiration
      const expiresAt = new Date(Date.now() + CODE_VALIDITY_SECONDS * 1000);

      // Store in database
      await this.db.client.authorizationCode.create({
        data: {
          id: createAuthorizationCodeId(),
          userCode,
          pollingCode,
          expiresAt,
          status: 'pending',
        },
      });

      // Build verification URL
      const clientUrl = this.config.getScratchApplicationUrl();
      const verificationUrl = `${clientUrl}/cli/authorize`;

      return {
        userCode,
        pollingCode,
        verificationUrl,
        expiresIn: CODE_VALIDITY_SECONDS,
        interval: POLL_INTERVAL_SECONDS,
      };
    } catch (error: unknown) {
      WSLogger.error({
        source: 'CliAuthService.initiateAuth',
        message: 'Failed to initiate auth',
        error,
      });
      return {
        error: error instanceof Error ? error.message : 'Failed to initiate authorization',
      };
    }
  }

  /**
   * Polls for authorization status using the polling code.
   * Returns the API token once the user has approved.
   */
  async pollAuth(pollingCode: string): Promise<AuthPollResponseDto> {
    try {
      const record = await this.db.client.authorizationCode.findUnique({
        where: { pollingCode },
      });

      if (!record) {
        return {
          status: 'denied',
          error: 'Invalid polling code',
        };
      }

      // Check if expired
      if (record.expiresAt < new Date()) {
        // Update status if not already expired
        if (record.status === 'pending') {
          await this.db.client.authorizationCode.update({
            where: { id: record.id },
            data: { status: 'expired' },
          });
        }
        return {
          status: 'expired',
          error: 'Authorization code has expired',
        };
      }

      if (record.status === 'approved' && record.apiToken) {
        // Get user email and token expiry for display
        let userEmail: string | undefined;
        let tokenExpiresAt: string | undefined;
        if (record.userId) {
          const user = await this.db.client.user.findUnique({
            where: { id: record.userId },
            select: { email: true },
          });
          userEmail = user?.email ?? undefined;

          // Get the token expiry date
          const token = await this.db.client.apiToken.findFirst({
            where: {
              token: record.apiToken,
            },
            select: { expiresAt: true },
          });
          tokenExpiresAt = token?.expiresAt?.toISOString();
        }

        return {
          status: 'approved',
          apiToken: record.apiToken,
          userEmail,
          tokenExpiresAt,
        };
      }

      if (record.status === 'denied') {
        return {
          status: 'denied',
          error: 'Authorization was denied',
        };
      }

      // Still pending
      return {
        status: 'pending',
      };
    } catch (error: unknown) {
      WSLogger.error({
        source: 'CliAuthService.pollAuth',
        message: 'Failed to poll auth',
        error,
      });
      return {
        status: 'denied',
        error: error instanceof Error ? error.message : 'Failed to check authorization status',
      };
    }
  }

  /**
   * Verifies a user code and approves the authorization.
   * Called from the web UI when a logged-in user enters the code.
   */
  async verifyAuth(userCode: string, userId: string): Promise<AuthVerifyResponseDto> {
    try {
      // Normalize user code (remove spaces, ensure uppercase)
      const normalizedCode = userCode.replace(/\s/g, '').toUpperCase();

      const record = await this.db.client.authorizationCode.findUnique({
        where: { userCode: normalizedCode },
      });

      if (!record) {
        return {
          success: false,
          error: 'Invalid authorization code',
        };
      }

      // Check if expired
      if (record.expiresAt < new Date()) {
        await this.db.client.authorizationCode.update({
          where: { id: record.id },
          data: { status: 'expired' },
        });
        return {
          success: false,
          error: 'Authorization code has expired',
        };
      }

      // Check if already used
      if (record.status !== 'pending') {
        return {
          success: false,
          error: 'Authorization code has already been used',
        };
      }

      // Calculate new expiry date (6 months from now)
      const newExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 180);

      // Look for an existing CLI API token for this user
      const existingToken = await this.db.client.apiToken.findFirst({
        where: {
          userId,
          type: TokenType.USER,
          scopes: { has: 'cli' },
        },
      });

      let apiToken: string;

      if (existingToken) {
        // Update the existing token's expiry date
        await this.db.client.apiToken.update({
          where: { id: existingToken.id },
          data: { expiresAt: newExpiresAt },
        });
        apiToken = existingToken.token;
      } else {
        // Create a new API token for CLI usage
        apiToken = generateApiToken();
        await this.db.client.apiToken.create({
          data: {
            id: createApiTokenId(),
            userId,
            token: apiToken,
            expiresAt: newExpiresAt,
            type: TokenType.USER,
            scopes: ['cli'],
          },
        });
      }

      // Update the authorization code record
      await this.db.client.authorizationCode.update({
        where: { id: record.id },
        data: {
          status: 'approved',
          userId,
          apiToken,
        },
      });

      return {
        success: true,
      };
    } catch (error: unknown) {
      WSLogger.error({
        source: 'CliAuthService.verifyAuth',
        message: 'Failed to verify auth',
        error,
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to verify authorization',
      };
    }
  }

  /**
   * Cleans up expired authorization codes.
   * Should be called periodically (e.g., via cron job).
   */
  async cleanupExpiredCodes(): Promise<number> {
    const result = await this.db.client.authorizationCode.deleteMany({
      where: {
        expiresAt: { lt: new Date() },
      },
    });
    return result.count;
  }
}
