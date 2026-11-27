import { Injectable } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import {
  createApiTokenId,
  createOrganizationId,
  createUserId,
  createWorkspacePermissionId,
  ScratchPlanType,
  TokenType,
  UpdateSettingsDto,
  WhalesyncSubscriptionPayload,
  WorkbookId,
} from '@spinner/shared-types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { UserCluster } from 'src/db/cluster-types';
import { EmailService } from 'src/email/email.service';
import { ExperimentsService } from 'src/experiments/experiments.service';
import { SystemFeatureFlag } from 'src/experiments/flags';
import { WSLogger } from 'src/logger';
import { StripePaymentService } from 'src/payment/stripe-payment.service';
import { PostHogService } from 'src/posthog/posthog.service';
import { SlackFormatters } from 'src/slack/slack-formatters';
import { SlackNotificationService } from 'src/slack/slack-notification.service';
import { isErr } from 'src/types/results';
import { WorkbookProvisioningService } from 'src/workbook/workbook-provisioning.service';
import { DbService } from '../db/db.service';
import {
  generateApiToken,
  generateTokenExpirationDate,
  generateWebsocketTokenExpirationDate,
  generateWhalesyncSessionTokenExpirationDate,
} from './tokens';
import {
  assertIsPureWhalesyncShadowUser,
  isPureWhalesyncShadowUser,
  pureShadowUserClerkIdForWhalesyncTeam,
  UserSettings,
} from './types';

// When the waitlist is required, the user is blocked from using the app and will get an email until an
// admin clicks approve.
const REQUIRE_WAITLIST_APPROVAL_FOR_NEW_USER = false;

/** Prisma's error for a write that would break a unique index, such as two shadow users for one Whalesync team. */
function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class UsersService {
  constructor(
    private readonly db: DbService,
    private readonly postHogService: PostHogService,
    private readonly configService: ScratchConfigService,
    private readonly slackNotificationService: SlackNotificationService,
    private readonly emailService: EmailService,
    private readonly workbookProvisioningService: WorkbookProvisioningService,
    private readonly experimentsService: ExperimentsService,
    private readonly stripePaymentService: StripePaymentService,
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
    let user = await this.findByClerkId(clerkUserId);

    // DEV-10731: on a clerkId miss, reconcile by email before creating. A Whalesync shadow row
    // (synthetic ws_<uuid> clerkId) may already own this address; blind-creating collides on the
    // @unique email → Prisma P2002 → the "Error loading user" 401. Adopt that row into the real
    // Clerk identity instead. (A Whalesync team's shadow user has no email, so it is never adopted.)
    if (!user && email) {
      const normalizedEmail = email.trim().toLowerCase();
      const userOwningEmail = await this.findByEmail(normalizedEmail);
      if (userOwningEmail) {
        user = await this.adoptExistingUserIntoClerkIdentity(userOwningEmail, clerkUserId);
      }
    }

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

    await this.maybeStartProTrialForNewUser(newUser);

    await this.slackNotificationService.sendMessage(SlackFormatters.newUserSignup(newUser));

    if (email) {
      await this.redeemWorkspaceInvites(email, newUser.id);
    }

    return newUser;
  }

  /**
   * If the `AUTO_TRIAL_SUBSCRIPTION_ON_SIGNUP` system flag is enabled for the newly-created user's
   * organization, start a 14-day Pro trial. Best-effort: any flag-evaluation or Stripe failure is
   * logged and swallowed so it can never block sign-up — the same stance
   * `createUserWithOrgAndDefaultWorkbook` takes for workbook provisioning.
   *
   * Only invoked from the native (Clerk) sign-up path, so Whalesync shadow users never get an
   * auto-trial. The `createTrialSubscription` guard keeps this idempotent: a user who already has a
   * subscription is left untouched.
   */
  private async maybeStartProTrialForNewUser(newUser: UserCluster.User): Promise<void> {
    try {
      if (!newUser.organizationId) {
        return;
      }

      const autoTrialEnabled = await this.experimentsService.getBooleanFlag(
        SystemFeatureFlag.AUTO_TRIAL_SUBSCRIPTION_ON_SIGNUP,
        false,
      );
      if (!autoTrialEnabled) {
        return;
      }

      const result = await this.stripePaymentService.createTrialSubscription(newUser, ScratchPlanType.PRO_PLAN);
      if (isErr(result)) {
        WSLogger.error({
          source: 'UsersService',
          message: `Failed to auto-start Pro trial for new user ${newUser.id}: ${result.error}`,
          error: result.cause,
        });
        return;
      }

      WSLogger.info({ source: 'UsersService', message: `Auto-started Pro trial for new user ${newUser.id}` });
    } catch (error) {
      WSLogger.error({
        source: 'UsersService',
        message: `Unexpected error auto-starting Pro trial for new user ${newUser.id}`,
        error,
      });
    }
  }

  /**
   * Creates a User with its auto-created Organization, a WEBSOCKET token, and a default Workbook.
   * This is the shared provisioning core used by both native (Clerk) sign-up and Whalesync shadow-user
   * provisioning. It performs only the database writes — analytics/Slack/invite side effects stay with
   * the caller so each provisioning path controls its own behavior.
   *
   * @param clerkId Real Clerk ID (`user_…`) for native users, or synthetic `ws_<whalesyncTeamId>` for shadow users.
   * @param whalesyncTeamId Set only for a Whalesync team's shadow user.
   */
  private async createUserWithOrgAndDefaultWorkbook(params: {
    clerkId: string;
    whalesyncTeamId?: string;
    name?: string;
    email?: string;
  }): Promise<UserCluster.User> {
    const { clerkId, whalesyncTeamId, name, email } = params;
    const newUserId = createUserId();
    const newOrganizationId = createOrganizationId();

    const newUser: UserCluster.User = await this.db.client.user.create({
      data: {
        id: newUserId,
        clerkId,
        whalesyncTeamId,
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

  /**
   * The shadow user that holds a Whalesync team's Live Exports, or null when the team has none (DEV-13019). Never
   * creates one. Refuses (409) a user with that team id that isn't a pure shadow user: see
   * {@link assertIsPureWhalesyncShadowUser}.
   */
  public async findShadowUserForWhalesyncTeam(
    whalesyncTeamId: string,
    attemptedOperation: Parameters<typeof assertIsPureWhalesyncShadowUser>[1],
  ): Promise<UserCluster.User | null> {
    const shadowUserOfTeam = await this.db.client.user.findUnique({
      where: { whalesyncTeamId },
      include: UserCluster._validator.include,
    });
    if (shadowUserOfTeam) {
      assertIsPureWhalesyncShadowUser(shadowUserOfTeam, attemptedOperation);
    }
    return shadowUserOfTeam;
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
   * Ensures the shadow user that holds a Whalesync team's Live Exports exists (DEV-13019), AND that its organization
   * is on the internal Whalesync plan. Idempotent on `whalesyncTeamId`. The plan is applied via
   * `StripePaymentService.ensureWhalesyncPlanSubscription` (itself idempotent and best-effort: existing Free shadow
   * users are self-healed onto the plan, and existing paid subscribers are left untouched).
   *
   * The optional `subscription` payload drives whether the plan is granted or revoked and records the
   * Whalesync-side subscription shape; when omitted it defaults to `{ status: 'active' }`, preserving the
   * historical auto-subscribe behavior.
   *
   * The shadow user is found by team, or created fresh: a pure shadow user with a synthetic `ws_<whalesyncTeamId>`
   * clerkId, `name` as its label, and no email. A team has no email of its own, so its shadow user is never matched to
   * a native Scratch account by email, in either direction. Scratch knows nothing about the people in the team, so
   * every member's session reaches the same shadow user. An existing shadow user's name is left alone.
   */
  public async getOrCreateShadowUserForWhalesyncTeam(
    whalesyncTeamId: string,
    name?: string,
    subscription?: WhalesyncSubscriptionPayload,
  ): Promise<UserCluster.User> {
    const shadowUser = await this.resolveShadowUserForWhalesyncTeam(whalesyncTeamId, name);
    await this.stripePaymentService.ensureWhalesyncPlanSubscription(shadowUser, subscription);
    return shadowUser;
  }

  private async resolveShadowUserForWhalesyncTeam(whalesyncTeamId: string, name?: string): Promise<UserCluster.User> {
    const existingShadowUser = await this.findShadowUserForWhalesyncTeam(whalesyncTeamId, 'session');
    if (existingShadowUser) {
      return existingShadowUser;
    }

    try {
      const newShadowUser = await this.createUserWithOrgAndDefaultWorkbook({
        clerkId: pureShadowUserClerkIdForWhalesyncTeam(whalesyncTeamId),
        whalesyncTeamId,
        name,
        // email omitted: the team has none.
      });
      this.postHogService.identifyNewUser(newShadowUser);
      return newShadowUser;
    } catch (error) {
      if (!isUniqueConstraintViolation(error)) {
        throw error;
      }
      // Two first sessions for the same team raced; the other one created the shadow user.
      const shadowUserCreatedConcurrently = await this.findShadowUserForWhalesyncTeam(whalesyncTeamId, 'session');
      if (!shadowUserCreatedConcurrently) {
        throw error;
      }
      return shadowUserCreatedConcurrently;
    }
  }

  /**
   * Links an existing Scratch user to a native Clerk identity by setting its `clerkId` (the "adopt by
   * email" path for {@link getOrCreateUserFromClerk}). Deliberately touches ONLY `clerkId`: the user's
   * email, organization, workbooks and subscription are preserved, so a row created without a Clerk
   * login (synthetic `ws_` clerkId) is linked rather than being duplicated into a `@unique` email
   * collision. A Whalesync team's shadow user has no email, so it never reaches here. Fires a dedicated
   * `clerk_account_linked` PostHog event and a Slack notification rather than `identifyNewUser` — the
   * user already exists and was identified when their shadow row was created; this is a link, not a
   * creation. Safe from DB constraints: the incoming `clerkUserId` was just missed on `findByClerkId`
   * (so it is unowned and `@unique` clerkId is satisfied), and the email is left untouched.
   */
  private async adoptExistingUserIntoClerkIdentity(
    existingUser: UserCluster.User,
    clerkUserId: string,
  ): Promise<UserCluster.User> {
    const replacingRealClerkIdentity = !!existingUser.clerkId && !isPureWhalesyncShadowUser(existingUser);
    const logContext = {
      source: 'UsersService',
      userId: existingUser.id,
      previousClerkId: existingUser.clerkId,
      clerkId: clerkUserId,
      whalesyncTeamId: existingUser.whalesyncTeamId,
    };
    if (replacingRealClerkIdentity) {
      // Anomalous: the email is already owned by a row with a real (non-shadow) Clerk id. Per Clerk's
      // unique-verified-email invariant this is the same human with a rotated/stale id, so re-link —
      // but surface it (warn) because overwriting a real login is not the expected shadow-adopt case.
      WSLogger.warn({
        ...logContext,
        message: 'Re-linking a Scratch user to a new real Clerk identity by email match',
      });
    } else {
      WSLogger.info({
        ...logContext,
        message: 'Adopting a Whalesync shadow user into a native Clerk identity by email match',
      });
    }

    const linkedUser = await this.db.client.user.update({
      where: { id: existingUser.id },
      data: { clerkId: clerkUserId },
      include: UserCluster._validator.include,
    });

    this.postHogService.trackClerkAccountLinked(linkedUser, clerkUserId);
    await this.slackNotificationService.sendMessage(SlackFormatters.clerkAccountLinked(linkedUser, clerkUserId));

    return linkedUser;
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
   * Whether the user is the only member of their organization. Drives whether tearing the user down also
   * deletes the organization and all of its workbooks (see `DevToolsService.hardDeleteUser` and
   * `WhalesyncInternalService.deleteShadowUserWithItsOrganizationAndOwnedWorkbooks`) and whether a
   * hard-delete would strand external collaborators — a user with no organization is never a sole member.
   */
  public async isSoleMemberOfOrganization(user: Pick<UserCluster.User, 'organizationId'>): Promise<boolean> {
    if (!user.organizationId) {
      return false;
    }
    return (await this.db.client.user.count({ where: { organizationId: user.organizationId } })) === 1;
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
          { whalesyncTeamId: { contains: query, mode: 'insensitive' } },
          { stripeCustomerId: { contains: query, mode: 'insensitive' } },
          { name: { contains: query, mode: 'insensitive' } },
          { email: { contains: query, mode: 'insensitive' } },
          // Exact organization-ID match so admins can paste an org ID and surface every user in that org.
          { organizationId: { equals: query } },
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
