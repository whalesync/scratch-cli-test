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
import { WSLogger } from 'src/logger';
import { PostHogService } from 'src/posthog/posthog.service';
import { SlackFormatters } from 'src/slack/slack-formatters';
import { SlackNotificationService } from 'src/slack/slack-notification.service';
import { WorkbookProvisioningService } from 'src/workbook/workbook-provisioning.service';
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
    private readonly workbookProvisioningService: WorkbookProvisioningService,
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

    // Create the default workspace for the new user via the shared provisioning service. This creates
    // the workbook row AND its config git repo together. Previously this path hand-rolled the workbook
    // row and forgot the repo, so the desktop's init-workspace 404'd ("Repository not found") when it
    // tried to clone the config repo. Routing both creation paths through one service keeps them from
    // diverging again. Failures are swallowed so a transient scratch-git outage can't block signup; the
    // user can create a workspace later.
    try {
      await this.workbookProvisioningService.createWorkbookWithConfigRepo({
        name: 'My Scratch workspace',
        ownerUserId: newUser.id,
        organizationId: newOrganizationId,
        setAsOwnerDefaultWorkspace: true,
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
   * Looks up a user by their (already-normalized) email. `User.email` is `@unique` and is stored
   * lowercased + trimmed by the `user_email_normalize` DB trigger, so callers must pass the email in
   * that same normalized form (`email.trim().toLowerCase()`) for the lookup to match.
   */
  public async findByEmail(normalizedEmail: string): Promise<UserCluster.User | null> {
    return this.db.client.user.findUnique({
      where: { email: normalizedEmail },
      include: UserCluster._validator.include,
    });
  }

  /**
   * Ensures a Scratch user exists for the given Whalesync user, reconciling against the existing
   * Scratch user base by email. Idempotent on `whalesyncUserId`. The incoming email is normalized
   * (lowercased + trimmed) to match the `user_email_normalize` DB trigger, then resolved in order:
   *
   * 1. **Already linked.** A Scratch user with this `whalesyncUserId` already exists → reuse it,
   *    refreshing `name`/`email` if they changed (the email refresh is collision-safe and also
   *    organically strips the legacy `ws:` prefix from pre-reconciliation shadow users).
   * 2. **Adopt by email.** An existing Scratch user owns this email and is *not* linked to any
   *    Whalesync user → link it by setting `whalesyncUserId`, rather than creating a duplicate. The
   *    adopted user keeps its real `clerkId`, email, organization and workbooks — it simply becomes
   *    reachable from the Whalesync identity too. This merges a native Scratch account with the
   *    Whalesync user that shares its address (the behavior the `ws:` prefix used to suppress).
   * 3. **Email already linked to a *different* Whalesync user.** A genuine collision: two distinct
   *    Whalesync users share one address. The `@unique` email + `@unique` whalesyncUserId both forbid
   *    adopting, so we create a fresh shadow user with a **null email** (we cannot claim an address
   *    another identity owns) and log a warning. Rare; surfaced rather than silently swallowed.
   * 4. **Create fresh.** Nobody owns the email → create a shadow user with the real, un-prefixed email
   *    and a synthetic `ws_<whalesyncUserId>` clerkId.
   *
   * The synthetic `ws_<whalesyncUserId>` clerkId (cases 3–4) satisfies the `@unique` clerkId column
   * and marks a purely-Whalesync user so server code can skip Clerk calls for `ws_`-prefixed users.
   * Slack sign-up notifications and invite redemption are intentionally skipped for shadow users.
   * PostHog identify is fired only for genuinely new users (cases 3–4); the adopt path (case 2) does
   * not re-identify, since the user already exists and was identified at native sign-up.
   */
  public async getOrCreateShadowUserFromWhalesync(
    whalesyncUserId: string,
    email: string,
    name?: string,
  ): Promise<UserCluster.User> {
    const normalizedEmail = email.trim().toLowerCase();

    // 1. Already linked to this Whalesync identity (idempotent on whalesyncUserId).
    const alreadyLinkedUser = await this.findByWhalesyncUserId(whalesyncUserId);
    if (alreadyLinkedUser) {
      return this.refreshLinkedUserNameAndEmailIfChanged(alreadyLinkedUser, name, normalizedEmail);
    }

    // 2/3. Reconcile against any existing Scratch user that already owns this email.
    const userOwningEmail = await this.findByEmail(normalizedEmail);
    if (userOwningEmail) {
      const emailIsLinkedToDifferentWhalesyncUser =
        !!userOwningEmail.whalesyncUserId && userOwningEmail.whalesyncUserId !== whalesyncUserId;

      if (emailIsLinkedToDifferentWhalesyncUser) {
        // 3. Two distinct Whalesync users share one address — cannot adopt or claim the email.
        WSLogger.warn({
          source: 'UsersService',
          message:
            'Whalesync email already linked to a different Whalesync user; provisioning a shadow user with no email',
          whalesyncUserId,
          conflictingWhalesyncUserId: userOwningEmail.whalesyncUserId,
          conflictingUserId: userOwningEmail.id,
        });
        const shadowUserWithoutEmail = await this.createUserWithOrgAndDefaultWorkbook({
          clerkId: `ws_${whalesyncUserId}`,
          whalesyncUserId,
          name,
          // email omitted: the address is owned by another identity and the column is @unique.
        });
        this.postHogService.identifyNewUser(shadowUserWithoutEmail);
        return shadowUserWithoutEmail;
      }

      // 2. Owned by a native (unlinked) Scratch user — adopt it into the Whalesync identity.
      return this.adoptExistingUserIntoWhalesyncIdentity(userOwningEmail, whalesyncUserId);
    }

    // 4. Nobody owns the email — create a fresh shadow user with the real, un-prefixed email.
    const newShadowUser = await this.createUserWithOrgAndDefaultWorkbook({
      clerkId: `ws_${whalesyncUserId}`,
      whalesyncUserId,
      name,
      email: normalizedEmail,
    });

    this.postHogService.identifyNewUser(newShadowUser);

    return newShadowUser;
  }

  /**
   * Links an existing, not-yet-linked Scratch user to a Whalesync identity by setting its
   * `whalesyncUserId` (the "adopt by email" path). Deliberately touches ONLY `whalesyncUserId`:
   * the user's real `clerkId` (their native Clerk login), email, organization, and workbooks are
   * preserved, so an adopted account becomes dual-identity (native + Whalesync) rather than being
   * overwritten. Fires a dedicated `whalesync_account_linked` PostHog event (with the Whalesync id)
   * rather than `identifyNewUser` — the user already exists and was identified at native sign-up, so
   * re-firing `account_user_created` would be wrong; this is a link, not a creation. Also posts a
   * Slack notification: linking a native account to Whalesync is rare and worth surfacing to the team.
   */
  private async adoptExistingUserIntoWhalesyncIdentity(
    existingUser: UserCluster.User,
    whalesyncUserId: string,
  ): Promise<UserCluster.User> {
    WSLogger.info({
      source: 'UsersService',
      message: 'Adopting an existing Scratch user into a Whalesync identity by email match',
      userId: existingUser.id,
      whalesyncUserId,
    });
    const linkedUser = await this.db.client.user.update({
      where: { id: existingUser.id },
      data: { whalesyncUserId },
      include: UserCluster._validator.include,
    });

    this.postHogService.trackWhalesyncAccountLinked(linkedUser, whalesyncUserId);
    await this.slackNotificationService.sendMessage(
      SlackFormatters.whalesyncAccountLinked(linkedUser, whalesyncUserId),
    );

    return linkedUser;
  }

  /**
   * Refreshes an already-linked user's `name`/`email` from the latest Whalesync values, writing only
   * the fields that changed. The email update is collision-safe: because `User.email` is `@unique`,
   * the new address is written only when no *other* Scratch user already owns it (otherwise the
   * update is skipped with a warning, leaving the existing value intact). This is also what strips
   * the legacy `ws:` prefix from shadow users provisioned before reconciliation — the first time they
   * reappear their stored `ws:<addr>` no longer matches the incoming `<addr>`, so it is rewritten.
   */
  private async refreshLinkedUserNameAndEmailIfChanged(
    linkedUser: UserCluster.User,
    incomingName: string | undefined,
    normalizedIncomingEmail: string,
  ): Promise<UserCluster.User> {
    const nameChanged = !!incomingName && incomingName !== linkedUser.name;
    const emailChanged = normalizedIncomingEmail !== linkedUser.email;

    let emailUpdateIsSafe = false;
    if (emailChanged) {
      const userOwningIncomingEmail = await this.findByEmail(normalizedIncomingEmail);
      emailUpdateIsSafe = !userOwningIncomingEmail || userOwningIncomingEmail.id === linkedUser.id;
      if (!emailUpdateIsSafe) {
        WSLogger.warn({
          source: 'UsersService',
          message: 'Skipping shadow-user email refresh: the incoming email is owned by a different Scratch user',
          userId: linkedUser.id,
          whalesyncUserId: linkedUser.whalesyncUserId,
        });
      }
    }

    if (!nameChanged && !(emailChanged && emailUpdateIsSafe)) {
      return linkedUser;
    }

    return this.db.client.user.update({
      where: { id: linkedUser.id },
      data: {
        ...(nameChanged ? { name: incomingName } : {}),
        ...(emailChanged && emailUpdateIsSafe ? { email: normalizedIncomingEmail } : {}),
      },
      include: UserCluster._validator.include,
    });
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
          { whalesyncUserId: { contains: query, mode: 'insensitive' } },
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
