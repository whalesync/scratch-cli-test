import { Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import {
  createApiTokenId,
  createOrganizationId,
  createUserId,
  createWorkspacePermissionId,
  TokenType,
  UpdateSettingsDto,
  WorkbookId,
} from '@spinner/shared-types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { UserCluster } from 'src/db/cluster-types';
import { EmailService } from 'src/email/email.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { SlackFormatters } from 'src/slack/slack-formatters';
import { SlackNotificationService } from 'src/slack/slack-notification.service';
import { DbService } from '../db/db.service';
import { generateApiToken, generateTokenExpirationDate, generateWebsocketTokenExpirationDate } from './tokens';
import { UserSettings } from './types';

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

    const newUserId = createUserId();
    const newOrganizationId = createOrganizationId();

    const newUser: UserCluster.User = await this.db.client.user.create({
      data: {
        id: newUserId,
        clerkId: clerkUserId,
        updatedAt: new Date(),
        role: UserRole.USER,
        name,
        email,
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
            clerkId: clerkUserId, // Note(chris): this should be Clerk's Organization ID, and will need to be fixed later when fully implement Clerk orgs
          },
        },
      },
      include: UserCluster._validator.include,
    });

    this.postHogService.identifyNewUser(newUser);

    await this.slackNotificationService.sendMessage(SlackFormatters.newUserSignup(newUser));

    if (email) {
      await this.redeemWorkspaceInvites(email, newUser.id);
    }

    return newUser;
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
      where: { email },
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
