import { Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import {
  createApiTokenId,
  createOrganizationId,
  createUserId,
  createWorkbookId,
  createWorkspacePermissionId,
  TokenType,
  UpdateSettingsDto,
  WorkbookId,
} from '@spinner/shared-types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { UserCluster } from 'src/db/cluster-types';
import { EmailService } from 'src/email/email.service';
import { WSLogger } from 'src/logger';
import { PostHogService } from 'src/posthog/posthog.service';
import { SlackFormatters } from 'src/slack/slack-formatters';
import { SlackNotificationService } from 'src/slack/slack-notification.service';
import { DbService } from '../db/db.service';
import {
  generateApiToken,
  generateTokenExpirationDate,
  generateWebsocketTokenExpirationDate,
  generateWhalesyncSessionTokenExpirationDate,
} from './tokens';
import { UserSettings } from './types';

// When the waitlist is required, the user is blocked from using the app and will get an email until an
// admin clicks approve.
const REQUIRE_WAITLIST_APPROVAL_FOR_NEW_USER = false;

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DbService,
    private readonly postHogService: PostHogService,
    private readonly configService: ScratchConfigService,
    private readonly slackNotificationService: SlackNotificationService,
    private readonly emailService: EmailService,
  ) {}

  public async findOne(id: string): Promise<UserCluster.User | null> {
    return this.db.client.user.findUnique({ where: { id }, include: UserCluster._validator.include });
  }

  public async findByClerkId(clerkId: string): Promise<UserCluster.User | null> {
    return this.db.client.user.findFirst({ where: { clerkId }, include: UserCluster._validator.include });
  }

  public async getUserFromAPIToken(apiToken: string): Promise<UserCluster.User | null> {
    return this.db.client.user.findFirst({
      where: {
        apiTokens: { some: { token: apiToken, expiresAt: { gt: new Date() } } },
      },
      include: UserCluster._validator.include,
    });
  }

  public async getOrCreateUserFromClerk(
    clerkUserId: string,
    name?: string,
    email?: string,
  ): Promise<UserCluster.User | null> {
    const user = await this.findByClerkId(clerkUserId);

    if (user) {
      // make sure the user has an api token
      if (user.apiTokens.length === 0) {
        const newToken = await this.db.client.apiToken.create({
          data: {
            id: createApiTokenId(),
            userId: user.id,
            token: generateApiToken(),
            expiresAt: generateWebsocketTokenExpirationDate(),
            type: TokenType.WEBSOCKET,
          },
        });

        return {
          ...user,
          apiTokens: [...user.apiTokens, newToken],
        };
      }

      // make sure the user has a websocket token
      const existingWebsocketToken = user.apiTokens.find((token) => token.type === (TokenType.WEBSOCKET as string));
      if (existingWebsocketToken) {
        // check expiry and if expired, update it
        if (existingWebsocketToken.expiresAt < new Date()) {
          const updatedToken = await this.db.client.apiToken.update({
            where: { id: existingWebsocketToken.id },
            data: { expiresAt: generateWebsocketTokenExpirationDate() },
          });
          user.apiTokens = user.apiTokens.map((token) =>
            token.id === existingWebsocketToken.id ? updatedToken : token,
          );
        }
      } else {
        const newToken = await this.db.client.apiToken.create({
          data: {
            id: createApiTokenId(),
            userId: user.id,
            token: generateApiToken(),
            expiresAt: generateWebsocketTokenExpirationDate(),
            type: TokenType.WEBSOCKET,
          },
        });
        user.apiTokens.push(newToken);
      }

      if ((name && name !== user.name) || (email && email !== user.email)) {
        await this.db.client.user.update({
          where: { id: user.id },
          data: { name, email },
        });
      }

      return user;
    }

    const newUser = await this.createUserWithOrgAndDefaultWorkbook({ clerkId: clerkUserId, name, email });

    this.postHogService.identifyNewUser(newUser);

    await this.slackNotificationService.sendMessage(SlackFormatters.newUserSignup(newUser));

    if (email) {
      await this.redeemWorkspaceInvites(email, newUser.id);
    }

    return newUser;
  }

  /**
   * Creates a User with its auto-created Organization, a WEBSOCKET token, and a default Workbook.
   * This is the shared provisioning core used by both native (Clerk) sign-up and Whalesync shadow-user
   * provisioning. It performs only the database writes — analytics/Slack/invite side effects stay with
   * the caller so each provisioning path controls its own behavior.
   *
   * @param clerkId Real Clerk ID (`user_…`) for native users, or synthetic `ws_<whalesyncUserId>` for shadow users.
   * @param whalesyncUserId Set only for Whalesync shadow users; null for native Scratch users.
   */
  private async createUserWithOrgAndDefaultWorkbook(params: {
    clerkId: string;
    whalesyncUserId?: string;
    name?: string;
    email?: string;
  }): Promise<UserCluster.User> {
    const { clerkId, whalesyncUserId, name, email } = params;
    const newUserId = createUserId();
    const newOrganizationId = createOrganizationId();

    const newUser: UserCluster.User = await this.db.client.user.create({
      data: {
        id: newUserId,
        clerkId,
        whalesyncUserId,
        updatedAt: new Date(),
        role: UserRole.USER,
        name,
        email,
        waitlistApproved: !REQUIRE_WAITLIST_APPROVAL_FOR_NEW_USER,
        apiTokens: {
          create: {
            id: createApiTokenId(),
            token: generateApiToken(),
            expiresAt: generateTokenExpirationDate(),
            type: TokenType.WEBSOCKET,
          },
        },
        organization: {
          create: {
            id: newOrganizationId,
            name: name ? `${name} Organization` : 'New Organization',
            clerkId, // Note(chris): this should be Clerk's Organization ID, and will need to be fixed later when fully implement Clerk orgs
          },
        },
      },
      include: UserCluster._validator.include,
    });

    // Create a default workspace for the new user, set as the new
    try {
      await this.db.client.workbook.create({
        data: {
          id: createWorkbookId(),
          name: 'My Scratch workspace',
          version: 2,
          userId: newUser.id,
          organizationId: newOrganizationId,
          workspacePermissions: {
            create: {
              id: createWorkspacePermissionId(),
              userId: newUser.id,
              role: 'editor',
            },
          },
          // Set it as default for the new user.
          usersWithAsDefault: { connect: { id: newUser.id } },
        },
      });
    } catch (error) {
      WSLogger.error({ source: 'UsersService', message: 'Failed to create default workspace', error });
    }

    return newUser;
  }

  public async findByWhalesyncUserId(whalesyncUserId: string): Promise<UserCluster.User | null> {
    return this.db.client.user.findFirst({
      where: { whalesyncUserId },
      include: UserCluster._validator.include,
    });
  }

  /**
   * Ensures a Scratch shadow user exists for the given Whalesync user, creating it on first call.
   * Idempotent on `whalesyncUserId`. Reuses the same provisioning core as native sign-up
   * ({@link createUserWithOrgAndDefaultWorkbook}), with two shadow-specific differences:
   *
   * - A synthetic `ws_<whalesyncUserId>` clerkId satisfies the `@unique` clerkId column and marks the
   *   user as Whalesync-provisioned (server code can skip Clerk calls for `ws_`-prefixed users).
   * - The email is stored with a `ws:` prefix so a shadow user never collides with a native Scratch
   *   user that has the same address on the `@unique` email column. The value is pre-normalized
   *   (lowercased + trimmed) to match the DB email-normalization trigger and avoid redundant updates.
   *
   * Slack sign-up notifications and invite redemption are intentionally skipped for shadow users;
   * PostHog identify is kept so the shadow-user person properties exist for analytics exclusion.
   */
  public async getOrCreateShadowUserFromWhalesync(
    whalesyncUserId: string,
    email: string,
    name?: string,
  ): Promise<UserCluster.User> {
    const normalizedShadowEmail = `ws:${email.trim().toLowerCase()}`;

    const existingShadowUser = await this.findByWhalesyncUserId(whalesyncUserId);
    if (existingShadowUser) {
      const nameChanged = !!name && name !== existingShadowUser.name;
      const emailChanged = normalizedShadowEmail !== existingShadowUser.email;
      if (nameChanged || emailChanged) {
        await this.db.client.user.update({
          where: { id: existingShadowUser.id },
          data: { name, email: normalizedShadowEmail },
        });
      }
      return existingShadowUser;
    }

    const newShadowUser = await this.createUserWithOrgAndDefaultWorkbook({
      clerkId: `ws_${whalesyncUserId}`,
      whalesyncUserId,
      name,
      email: normalizedShadowEmail,
    });

    this.postHogService.identifyNewUser(newShadowUser);

    return newShadowUser;
  }

  /**
   * Mints a short-lived WHALESYNC_SESSION token for a shadow user. Additive — it does NOT delete the
   * user's other tokens, since overlapping refresh windows are expected and expired rows are reaped by
   * the {@link ExpiredApiTokenCleanupService} cron rather than on mint.
   */
  public async mintWhalesyncSessionToken(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const newSessionToken = await this.db.client.apiToken.create({
      data: {
        id: createApiTokenId(),
        userId,
        token: generateApiToken(),
        expiresAt: generateWhalesyncSessionTokenExpirationDate(),
        type: TokenType.WHALESYNC_SESSION,
      },
    });
    return { token: newSessionToken.token, expiresAt: newSessionToken.expiresAt };
  }

  /**
   * Bulk-revokes a user's WHALESYNC_SESSION tokens (logout / deprovision). Only deletes
   * WHALESYNC_SESSION rows, so the user's CLI/desktop (USER/WEBSOCKET) tokens are unaffected.
   * @returns the number of session tokens deleted
   */
  public async revokeWhalesyncSessionTokens(userId: string): Promise<number> {
    const { count } = await this.db.client.apiToken.deleteMany({
      where: { userId, type: TokenType.WHALESYNC_SESSION },
    });
    return count;
  }

  /**
   * Deletes a shadow user's database rows during deprovisioning. Call this only AFTER the user's
   * workbooks have been torn down via `WorkbookService.delete` (workbooks FK both the user and the
   * auto-created organization). Deleting the user cascades its `ApiToken` rows; the auto-created
   * organization is then removed. A failure to delete the organization (e.g. an unexpected lingering
   * reference) is logged and skipped rather than aborting the deprovision.
   */
  public async deleteShadowUserAndOrganization(userId: string, organizationId?: string): Promise<void> {
    await this.db.client.user.delete({ where: { id: userId } });

    if (organizationId) {
      try {
        await this.db.client.organization.delete({ where: { id: organizationId } });
      } catch (error) {
        WSLogger.warn({
          source: 'UsersService',
          message: 'Failed to delete shadow user organization during deprovision; skipping',
          organizationId,
          error,
        });
      }
    }
  }

  public async search(query: string): Promise<UserCluster.User[]> {
    return this.db.client.user.findMany({
      where: {
        OR: [
          { id: { contains: query, mode: 'insensitive' } },
          { clerkId: { contains: query, mode: 'insensitive' } },
          { stripeCustomerId: { contains: query, mode: 'insensitive' } },
          { name: { contains: query, mode: 'insensitive' } },
          { email: { contains: query, mode: 'insensitive' } },
        ],
      },
      orderBy: {
        updatedAt: 'desc',
      },
      include: UserCluster._validator.include,
    });
  }

  /**
   * Creates or regenerates a USER type API token for the given user.
   * If the user already has a USER token, it will be deleted and replaced.
   * @returns The new API token string
   */
  public async generateUserApiToken(userId: string): Promise<string> {
    // Delete any existing USER tokens for this user
    await this.db.client.apiToken.deleteMany({
      where: { userId, type: TokenType.USER },
    });

    // Create a new USER token
    const newToken = await this.db.client.apiToken.create({
      data: {
        id: createApiTokenId(),
        userId,
        token: generateApiToken(),
        expiresAt: generateTokenExpirationDate(),
        type: TokenType.USER,
      },
    });

    return newToken.token;
  }

  public async updateUserSettings(user: UserCluster.User, dto: UpdateSettingsDto): Promise<void> {
    const existingSettings = (user.settings ?? {}) as UserSettings;

    let updatedSettings = {
      ...existingSettings,
      ...dto.updates,
    };

    // filter out null values as those should remove the key from the settings object
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    updatedSettings = Object.fromEntries(Object.entries(updatedSettings).filter(([_, value]) => value !== null));

    await this.db.client.user.update({
      where: { id: user.id },
      data: { settings: updatedSettings },
    });
  }

  private async redeemWorkspaceInvites(email: string, userId: string): Promise<void> {
    const invites = await this.db.client.workspaceInvites.findMany({
      where: { email: email.trim().toLowerCase() },
    });

    if (invites.length === 0) {
      return;
    }

    await this.db.client.$transaction(
      invites.flatMap((invite) => [
        this.db.client.workspacePermission.create({
          data: {
            id: createWorkspacePermissionId(),
            workbookId: invite.workbookId as WorkbookId,
            userId,
            role: 'editor',
          },
        }),
        this.db.client.workspaceInvites.delete({
          where: { id: invite.id },
        }),
      ]),
    );

    const user = await this.db.client.user.findUnique({ where: { id: userId }, select: { name: true } });
    const acceptedByName = user?.name ?? email;

    for (const invite of invites) {
      if (!invite.userId) {
        continue;
      }

      const [inviter, workbook] = await Promise.all([
        this.db.client.user.findUnique({ where: { id: invite.userId }, select: { email: true } }),
        this.db.client.workbook.findUnique({ where: { id: invite.workbookId }, select: { name: true } }),
      ]);

      if (inviter?.email) {
        void this.emailService.sendInviteAccepted({
          to: inviter.email,
          acceptedByName,
          workspaceName: workbook?.name ?? 'a workspace',
        });
      }
    }
  }

  public async updateLastWorkbook(userId: string, workbookId: string | null): Promise<void> {
    await this.db.client.user.update({
      where: { id: userId },
      data: { lastWorkbookId: workbookId },
    });
  }
}
