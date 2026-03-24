import { Injectable } from '@nestjs/common';
import { User } from '@prisma/client';
import {
  createInvoiceResultId,
  CreatePortalDto,
  createSubscriptionId,
  ScratchPlanType,
  SubscriptionId,
} from '@spinner/shared-types';
import _ from 'lodash';
import { AuditLogService } from 'src/audit/audit-log.service';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { UserCluster } from 'src/db/cluster-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { PostHogService } from 'src/posthog/posthog.service';
import { SlackFormatters } from 'src/slack/slack-formatters';
import { SlackNotificationService } from 'src/slack/slack-notification.service';
import {
  AsyncResult,
  badRequestError,
  ErrorCode,
  errResult,
  isErr,
  ok,
  Result,
  stripeLibraryError,
  unauthorizedError,
  unexpectedError,
} from 'src/types/results';
import { userToActor } from 'src/users/types';
import Stripe from 'stripe';
import { getActiveSubscriptions, getLastestExpiringSubscription, isActiveSubscriptionOwnedByUser } from './helpers';
import { getPlan, getPlans } from './plans';

/**
 * The version of the API we are expecting, from: https://stripe.com/docs/api/versioning
 * For upgrading this, see: https://stripe.com/docs/upgrades#api-versions
 */
const STRIPE_API_VERSION = '2025-08-27.basil';
const TRIAL_PERIOD_DAYS = 7;

type StripeWebhookResult = 'success' | 'ignored';

// Client path that we redirect to if the checkout is successful.
const DEFAULT_SUCCESS_PATH = '/billing?welcome';
// Client path that we redirect to if the checkout is canceled.
const DEFAULT_CANCEL_PATH = '/billing';
// Client path that we redirect to if the user clicks the "Manage Subscription" button in the settings page.
const PORTAL_RETURN_PATH = '/billing';

// Attached to all subscriptions created by Scratch.
const METADATA_APPLICATION_NAME = 'scratch';

@Injectable()
export class StripePaymentService {
  private stripe: Stripe;
  private stripeWebhookSecret: string;

  constructor(
    private readonly configService: ScratchConfigService,
    private readonly dbService: DbService,
    private readonly postHogService: PostHogService,
    private readonly slackNotificationService: SlackNotificationService,
    private readonly auditLogService: AuditLogService,
  ) {
    this.stripe = new Stripe(this.configService.getStripeApiKey(), {
      apiVersion: STRIPE_API_VERSION,
    });
    this.stripeWebhookSecret = this.configService.getStripeWebhookSecret();
  }

  async generateNewCustomerId(user: User): AsyncResult<string> {
    WSLogger.info({
      source: StripePaymentService.name,
      message: `Generating new customer ID for user ${user.id}`,
    });

    let response: Stripe.Customer;
    try {
      // Keep it mostly empty to create a blank customer.
      response = await this.stripe.customers.create({
        name: user.name ?? '',
        email: user.email ?? undefined,
        metadata: {
          source: 'scratch', // used to identify new users created from Scratch vs Whalesync
          internal_id: user.id,
          environment: this.configService.getScratchEnvironment(),
        },
      });
      WSLogger.info({
        source: StripePaymentService.name,
        message: `New customer created with ID ${response.id} for user ${user.id}`,
      });
    } catch (err) {
      WSLogger.error({
        source: StripePaymentService.name,
        message: `Failed to generate new customer for user ${user.id}`,
        error: err,
      });
      return errResult(ErrorCode.StripeLibraryError, `Failed to generate new customer: ${_.toString(err)}`);
    }
    return ok(response.id);
  }

  /**
   * Creates a trial subscription on Stripe for a user withouth going through checkout or the billing portal
   * @param user - The user to create the trial subscription for
   * @returns A result indicating success or a failure message
   */
  async createTrialSubscription(user: UserCluster.User, planType: ScratchPlanType): AsyncResult<string> {
    WSLogger.info({
      source: StripePaymentService.name,
      message: `Creating trial subscription for user ${user.id}`,
    });

    const stripePriceId = this.getDefaultPriceId(planType);
    if (!stripePriceId) {
      return unexpectedError(`No stripe product id for ${planType}`);
    }

    const stripeCustomerId = await this.upsertStripeCustomerId(user);
    if (isErr(stripeCustomerId)) {
      return stripeCustomerId;
    }

    try {
      const subscription = await this.stripe.subscriptions.create({
        customer: stripeCustomerId.v,
        items: [{ price: stripePriceId, quantity: 1 }],
        trial_period_days: TRIAL_PERIOD_DAYS,
        metadata: {
          application: METADATA_APPLICATION_NAME,
          planType: planType,
          environment: this.configService.getScratchEnvironment(),
        },
        trial_settings: {
          end_behavior: {
            missing_payment_method: 'cancel',
          },
        },
        automatic_tax: { enabled: false },
      });

      const result = await this.upsertSubscription(subscription.id, undefined, subscription);
      if (isErr(result)) {
        return result;
      }

      this.postHogService.trackTrialStarted(userToActor(user), planType);

      return ok('success');
    } catch (err) {
      return stripeLibraryError(`Failed to create trial subscription: ${_.toString(err)}`, {
        context: { stripeCustomerId, stripePriceId },
      });
    }
  }

  async createCustomerPortalUrl(user: UserCluster.User, dto: CreatePortalDto): AsyncResult<string> {
    WSLogger.info({
      source: StripePaymentService.name,
      message: `Creating customer portal URL for user ${user.id}`,
      config: dto,
    });

    // If the user doesn't have an active subscription on the organization they can't access the billing portal.
    // TODO: handle the case where a different user in the organization owns the subscription.
    if (!isActiveSubscriptionOwnedByUser(user.organization?.subscriptions ?? [], user.id)) {
      return badRequestError('You do not own the active subscription for this organization');
    }

    const currentSubscription = getLastestExpiringSubscription(user.organization?.subscriptions ?? []);

    const stripeCustomerId = await this.upsertStripeCustomerId(user);
    if (isErr(stripeCustomerId)) {
      return stripeCustomerId;
    }

    const portalSessionConfig: Stripe.BillingPortal.SessionCreateParams = {
      customer: stripeCustomerId.v,
      return_url: `${ScratchConfigService.getClientBaseUrl()}${PORTAL_RETURN_PATH}`,
    };

    if (dto.portalType === 'update_subscription') {
      if (!currentSubscription) {
        return badRequestError('You do not have an active subscription to cancel');
      }

      portalSessionConfig.flow_data = {
        type: 'subscription_update',
        subscription_update: {
          subscription: currentSubscription.stripeSubscriptionId,
        },
      };
    } else if (dto.portalType === 'cancel_subscription') {
      if (!currentSubscription) {
        return badRequestError('You do not have an active subscription to cancel');
      }

      portalSessionConfig.flow_data = {
        type: 'subscription_cancel',
        subscription_cancel: {
          subscription: currentSubscription.stripeSubscriptionId,
        },
      };
    } else if (dto.portalType === 'manage_payment_methods') {
      portalSessionConfig.flow_data = {
        type: 'payment_method_update',
      };
    }

    let portalSession: Stripe.BillingPortal.Session;

    try {
      portalSession = await this.stripe.billingPortal.sessions.create(portalSessionConfig, {
        apiVersion: STRIPE_API_VERSION,
      });
    } catch (err) {
      WSLogger.error({
        source: StripePaymentService.name,
        message: `Failed to create customer portal session`,
        error: err,
        context: { portalSessionConfig },
      });
      return stripeLibraryError(`Failed to create customer portal session: ${_.toString(err)}`, {
        context: { portalSessionConfig },
      });
    }

    WSLogger.info({
      source: StripePaymentService.name,
      message: `Generated customer portal URL for user ${user.id}`,
      url: portalSession.url,
    });
    return ok(portalSession.url);
  }

  async generateCheckoutUrl(
    user: UserCluster.User,
    planType: ScratchPlanType,
    createTrialSubscription: boolean = false,
    returnPath: string = DEFAULT_SUCCESS_PATH,
  ): AsyncResult<string> {
    WSLogger.info({
      source: StripePaymentService.name,
      message: `Generating checkout URL for user ${user.id}, product ${planType}`,
    });

    // Never allow someone to checkout again if they already have a current subscription on the organization.
    // Instead send them to manage the existing one.
    // TODO: handle the case where a different user in the organization owns the subscription.
    if (getActiveSubscriptions(user.organization?.subscriptions ?? []).length > 0) {
      return this.createCustomerPortalUrl(user, { returnPath: returnPath });
    }

    const stripePriceId = this.getDefaultPriceId(planType);
    if (!stripePriceId) {
      return unexpectedError(`No stripe product id for ${planType}`);
    }

    const stripeCustomerId = await this.upsertStripeCustomerId(user);
    if (isErr(stripeCustomerId)) {
      return stripeCustomerId;
    }

    const clientBaseUrl = ScratchConfigService.getClientBaseUrl();

    const automaticTaxEnabled = this.configService.getScratchEnvironment() === 'production';
    try {
      const session = await this.stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          line_items: [
            {
              price: stripePriceId,
              quantity: 1,
            },
          ],
          customer: stripeCustomerId.v,

          subscription_data: {
            trial_period_days: createTrialSubscription ? TRIAL_PERIOD_DAYS : undefined,
            metadata: {
              application: METADATA_APPLICATION_NAME,
              planType: planType,
              environment: this.configService.getScratchEnvironment(),
            },
            trial_settings: createTrialSubscription
              ? {
                  end_behavior: {
                    missing_payment_method: 'cancel',
                  },
                }
              : undefined,
          },
          // Only collect payment method if the cost of the subscription is greater than $0 or if a free trial is not available.
          payment_method_collection: createTrialSubscription ? 'if_required' : 'always',

          // We must enable this to properly auto-collect taxes for customers based on their location.
          automatic_tax: { enabled: automaticTaxEnabled },
          customer_update: { address: 'auto', name: 'auto' },

          // In event of either success or failure, send them back to the dashboard root page to sort things
          // out. It has logic to redirect to an appropriate sub-view afterwards.
          success_url: `${clientBaseUrl}${returnPath}`,
          cancel_url: `${clientBaseUrl}${DEFAULT_CANCEL_PATH}`,
          allow_promotion_codes: true,

          // Allows the customer to enter their tax ID number.
          tax_id_collection: { enabled: true },
        },
        {
          apiVersion: STRIPE_API_VERSION,
        },
      );

      if (session.url) {
        WSLogger.info({
          source: StripePaymentService.name,
          message: `Generated checkout URL for user ${user.id}`,
          url: session.url,
        });
        return ok(session.url);
      } else {
        return stripeLibraryError('No URL returned from Stripe');
      }
    } catch (err) {
      WSLogger.error({
        source: StripePaymentService.name,
        message: `Failed to create checkout session for user`,
        error: err,
        context: { stripePriceId, stripeCustomerId, userId: user.id, planType, createTrialSubscription, returnPath },
      });
      return stripeLibraryError(`Failed to create checkout session: ${_.toString(err)}`, {
        context: { stripePriceId, stripeCustomerId },
      });
    }
  }

  /**
   * Returns the Stripe customer ID for a user. If the user doesn't have one yet, it creates one and updates the user in
   * the database.
   */
  private async upsertStripeCustomerId(user: UserCluster.User): AsyncResult<string> {
    if (user.stripeCustomerId) {
      return ok(user.stripeCustomerId);
    }

    // We need to generate one and save it on the user.
    const result = await this.generateNewCustomerId(user);
    if (isErr(result)) {
      return result;
    }

    const newStripeCustomerId = result.v;
    try {
      await this.dbService.client.user.update({
        where: { id: user.id },
        data: { stripeCustomerId: newStripeCustomerId },
        include: UserCluster._validator.include,
      });
    } catch (err) {
      return unexpectedError('There was a problem with saving the Stripe ID on the user', { cause: err as Error });
    }
    return ok(newStripeCustomerId);
  }

  async handleWebhookCallback(requestBody: string, signatureHeader: string): AsyncResult<StripeWebhookResult> {
    WSLogger.info({
      source: StripePaymentService.name,
      message: `Starting to handle webhook callback`,
    });

    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(requestBody, signatureHeader, this.stripeWebhookSecret);
    } catch (err) {
      const error = err as Error;
      WSLogger.error({
        source: StripePaymentService.name,
        message: `⚠️  Webhook signature verification failed`,
        error: { name: error.name, message: error.message, stack: error.stack },
      });
      return unauthorizedError('Webhook signature verification failed');
    }

    WSLogger.info({
      source: StripePaymentService.name,
      message: `Processing Stripe webhook event`,
      eventType: event.type,
    });

    let result: Result<StripeWebhookResult>;
    switch (event.type) {
      case 'checkout.session.completed':
        // Initial payment is successful and the subscription is created.
        result = await this.handleCheckoutSessionCompleted(event.data.object);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        // A subscription changed (switching from one plan to another, or changing the status from trial to active).
        result = await this.handleCustomerSubscriptionUpdated(event);
        break;
      case 'invoice.paid':
        // A charge has gone through successfully.
        result = await this.handleInvoicePaid(event.data.object);
        break;
      case 'invoice.payment_failed':
        // The payment failed or the customer does not have a valid payment method.
        // The subscription becomes past_due.
        result = await this.handleInvoiceFailed(event.data.object);
        break;
      default:
        // NOTE! There's a bunch more that would let us know more about when it's getting ready to expire.
        // If you add more you need to add them to:
        // Staging: https://dashboard.stripe.com/test/webhooks/we_1KhNmyB3kcxQq5fuTyvOImPi
        // and Production: https://dashboard.stripe.com/webhooks/we_1KhNqVB3kcxQq5fuVE6hGARg
        // Seen events: invoice.created, invoice.finalized, invoice.payment_succeeded
        WSLogger.info({
          source: StripePaymentService.name,
          message: `Unhandled Stripe webhook event type: ${event.type}`,
        });

        result = ok('success');
    }

    WSLogger.info({
      source: StripePaymentService.name,
      message: 'Finished processing Stripe webhook callback',
      result: result,
      eventType: event.type,
    });

    return result;
  }

  /*
  Stripe webhookevent handlers
  */
  private async handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): AsyncResult<StripeWebhookResult> {
    WSLogger.info({
      source: StripePaymentService.name,
      message: `Handling checkout session completed`,
      sessionId: session.id,
    });

    const stripeSubscriptionId = session.subscription as string;
    if (!stripeSubscriptionId) {
      WSLogger.error({
        source: StripePaymentService.name,
        message: `checkout.session.completed missing subscription field`,
        session,
      });

      return badRequestError('checkout.session.completed missing subscription field');
    }

    return this.upsertSubscription(stripeSubscriptionId, undefined);
  }

  private async handleCustomerSubscriptionUpdated(event: Stripe.Event): AsyncResult<StripeWebhookResult> {
    const subscription = event.data.object as Stripe.Subscription;
    const eventType = event.type;

    WSLogger.info({
      source: StripePaymentService.name,
      message: `Handling customer subscription updated`,
      eventType: eventType,
      subscriptionId: subscription.id,
    });

    const stripeSubscriptionId = subscription.id;
    if (!stripeSubscriptionId) {
      return badRequestError('customer.subscription.updated missing id field');
    }

    return this.upsertSubscription(stripeSubscriptionId, undefined);
  }

  private async handleInvoicePaid(invoice: Stripe.Invoice): AsyncResult<StripeWebhookResult> {
    WSLogger.info({
      source: StripePaymentService.name,
      message: `Handling invoice paid`,
      invoiceId: invoice.id,
    });

    let updateCount = 0;

    for (const line of invoice.lines.data) {
      if (!line.parent || line.parent.type !== 'subscription_item_details' || !line.parent.subscription_item_details) {
        WSLogger.debug({
          source: StripePaymentService.name,
          message: `Skipping upsert for line item with no subscription parent`,
          line,
        });
        continue;
      }

      const stripeSubscriptionId = line.parent.subscription_item_details?.subscription;
      if (!stripeSubscriptionId) {
        WSLogger.error({
          source: StripePaymentService.name,
          message: `invoice.paid stripe webhook contains non-subscription items`,
          line,
        });
        continue; // In case there's something that's not a subcription on the invoice.
      }
      const result = await this.upsertSubscription(stripeSubscriptionId, true);
      if (isErr(result)) {
        return unexpectedError('Subscription could not update', { cause: result.cause });
      } else if (result.v === 'success') {
        updateCount++;
      }
    }

    if (updateCount > 0) {
      // Only log invoice results if we actually updated a subscription
      const user = await this.getUserFromStripeCustomerId(invoice.customer as string);
      if (user) {
        if (!user.organizationId) {
          return unexpectedError('User does not have an organization id', { context: { userId: user.id } });
        }

        try {
          await this.dbService.client.invoiceResult.create({
            data: {
              id: createInvoiceResultId(),
              userId: user.id,
              organizationId: user.organizationId, // invoice results belong to the organization, not the user
              invoiceId: invoice.id as string,
              succeeded: true,
            },
          });
        } catch (err) {
          WSLogger.error({
            source: StripePaymentService.name,
            message: `Failed to create invoice result`,
            invoiceId: invoice.id,
            error: err,
          });
        }
      }
    }
    return ok('success');
  }

  private async handleInvoiceFailed(invoice: Stripe.Invoice): AsyncResult<StripeWebhookResult> {
    WSLogger.info({
      source: StripePaymentService.name,
      message: `Handling invoice failed`,
      invoiceId: invoice.id,
    });

    let updateCount = 0;

    // there could be multiple items on the invoice but normally it should just be one subscription
    for (const line of invoice.lines.data) {
      const stripeSubscriptionId = line.subscription as string;
      if (!stripeSubscriptionId) {
        WSLogger.error({
          source: StripePaymentService.name,
          message: `invoice.payment_failed stripe webhook contains non-subscription items`,
        });
        continue; // In case there's something that's not a subcription on the invoice.
      }

      const subscription = await this.getSubscriptionFromStripe(stripeSubscriptionId);
      if (isErr(subscription)) {
        WSLogger.error({
          source: StripePaymentService.name,
          message: `Failed to get subscription`,
          error: subscription.cause,
          subscriptionId: stripeSubscriptionId,
        });
        continue;
      }

      if (!this.isCurrentScratchEnvironment(subscription.v)) {
        WSLogger.info({
          source: StripePaymentService.name,
          message: `Skipping upsert for different scratch environment`,
          subscriptionId: stripeSubscriptionId,
          environment: subscription.v.metadata.environment,
        });
        continue;
      }

      try {
        await this.dbService.client.subscription.update({
          where: { stripeSubscriptionId },
          data: { lastInvoicePaid: false },
        });
        updateCount++;
      } catch (err) {
        WSLogger.error({
          source: StripePaymentService.name,
          message: `Failed to update subscription with no invoice paid`,
          error: err,
          subscriptionId: stripeSubscriptionId,
        });
      }
    }

    return ok(updateCount > 0 ? 'success' : 'ignored');
  }

  private async getSubscriptionFromStripe(stripeSubscriptionId: string): AsyncResult<Stripe.Subscription> {
    try {
      return ok(await this.stripe.subscriptions.retrieve(stripeSubscriptionId));
    } catch (err) {
      return stripeLibraryError(`Failed to retrieve subscription: ${_.toString(err)}`, {
        context: { stripeSubscriptionId },
      });
    }
  }

  private isCurrentScratchEnvironment(subscription: Stripe.Subscription): boolean {
    const appEnv = this.configService.getScratchEnvironment();
    return subscription.metadata.environment === appEnv;
  }

  /**
   * Create or update a subscription we've been notified has changed.
   * Polls Stripe to get the latest data for the subscription, then looks up the subscription handling.
   *
   * If the user changes the plan they are on, it keeps the same subcriptionId and will update in place here.
   */
  public async upsertSubscription(
    stripeSubscriptionId: string,
    lastInvoicePaid: boolean | undefined,
    subscriptionData?: Stripe.Subscription,
  ): AsyncResult<'success' | 'ignored'> {
    WSLogger.info({
      source: StripePaymentService.name,
      message: `Upserting subscription`,
      subscriptionId: stripeSubscriptionId,
    });

    let subscription: Stripe.Subscription;
    if (subscriptionData) {
      subscription = subscriptionData;
    } else {
      const getSubscriptionResult = await this.getSubscriptionFromStripe(stripeSubscriptionId);
      if (isErr(getSubscriptionResult)) {
        return getSubscriptionResult;
      }

      subscription = getSubscriptionResult.v;
    }

    // Make sure the subscription is for the correct scratch environment.
    if (!this.isCurrentScratchEnvironment(subscription)) {
      WSLogger.info({
        source: StripePaymentService.name,
        message: `Skipping upsert for different scratch environment`,
        subscriptionId: stripeSubscriptionId,
        environment: subscription.metadata.environment,
      });
      return ok('ignored');
    }

    // Search for the first item with a plan we recognize, so we can record what plan they are on.
    // We currently only expect there to be one plan per subscription, but that's not guaranteed.
    const planType = this.getPlanTypeFromSubscription(subscription);
    if (!planType) {
      return unexpectedError('No subscription item attached with plan we recognized.', {
        context: { stripeSubscriptionId },
      });
    }

    const plan = getPlan(planType as ScratchPlanType);
    if (!plan) {
      return unexpectedError('No plan found for product type', { context: { planType } });
    }

    const stripeCustomerId = subscription.customer as string;
    const expiration = this.findExpirationFromSubscription(subscription);
    const cancelAt = this.findCancelDateFromSubscription(subscription);
    const priceInDollars = this.findPriceInDollarsForSubscription(subscription);

    // This shouldn't happen, but if it does, we want to ignore the payload.
    // Our preprod environments all share a stripe developer account, so they both receive notifications for each
    // other's users. In prod, we want to return a failure to the webhook if the payload doesn't match our database, but
    // that is a regular occurence on the dev account. If we regularly return failures, it will get our webhooks
    // disabled.
    if (!this.configService.isProductionEnvironment()) {
      const isKnown = await this.isKnownStripeCustomerId(stripeCustomerId);
      if (!isKnown) {
        WSLogger.info({
          source: StripePaymentService.name,
          message: `Skipping upsert for unknown user in non-production environment`,
          subscriptionId: stripeSubscriptionId,
          stripeCustomerId: stripeCustomerId,
        });
        return ok('ignored');
      }
    }

    // This should always be an insert, except if the same message is delivered twice accidentally.
    try {
      const user = await this.getUserFromStripeCustomerId(stripeCustomerId);
      if (!user) {
        return unexpectedError('User not found', { context: { stripeCustomerId } });
      }

      if (!user.organizationId) {
        return unexpectedError('User does not have an organization id', { context: { userId: user.id } });
      }

      const existingSubscription = user.organization?.subscriptions.find(
        (s) => s.stripeSubscriptionId === stripeSubscriptionId,
      );

      const updatedDbSubscription = await this.dbService.client.subscription.upsert({
        where: { stripeSubscriptionId },
        create: {
          id: createSubscriptionId(),
          userId: user.id,
          organizationId: user.organizationId, // subscriptions belong to the organization, not the user
          stripeSubscriptionId,
          expiration,
          planType,
          priceInDollars,
          lastInvoicePaid,
          stripeStatus: subscription.status,
          cancelAt: cancelAt,
        },
        update: {
          expiration,
          planType,
          priceInDollars,
          lastInvoicePaid,
          stripeStatus: subscription.status,
          cancelAt: cancelAt,
        },
      });

      if (subscription.status === 'active' || subscription.status === 'trialing') {
        // only update if the subscription is new or the plan has changed
        if (!existingSubscription || existingSubscription.planType !== planType) {
          const previousPlanType = existingSubscription ? existingSubscription.planType : ScratchPlanType.FREE_PLAN;
          await this.slackNotificationService.sendMessage(
            `${SlackFormatters.userIdentifier(user, '💳')} has switch plans: ${previousPlanType} -> ${plan.planType}!`,
          );
          await this.auditLogService.logEvent({
            actor: userToActor(user),
            eventType: 'update',
            message: `Switched plans: ${previousPlanType} -> ${plan.planType}!`,
            entityId: updatedDbSubscription.id as SubscriptionId,
          });
          this.postHogService.trackSubscriptionChanged(
            userToActor(user),
            previousPlanType as ScratchPlanType,
            plan.planType,
          );
        }
      }

      if (cancelAt) {
        this.postHogService.trackSubscriptionCancelled(userToActor(user), plan.planType);
        await this.slackNotificationService.sendMessage(
          `${SlackFormatters.userIdentifier(user, '😿')} has canceled their subscription for the ${plan.planType}`,
        );
        await this.auditLogService.logEvent({
          actor: userToActor(user),
          eventType: 'update',
          message: `Downgraded to the free plan`,
          entityId: updatedDbSubscription.id as SubscriptionId,
        });
      }
    } catch (err) {
      WSLogger.error({
        source: StripePaymentService.name,
        message: `Failed to upsert subscription`,
        subscriptionId: stripeSubscriptionId,
        error: err,
      });
      return unexpectedError('Failed to upsert subscription', { cause: err as Error });
    }
    WSLogger.info({
      source: StripePaymentService.name,
      message: `Successfully upserted subscription`,
      subscriptionId: stripeSubscriptionId,
    });
    return ok('success');
  }

  /**
   * User DB Functions
   * These exist here to avoid circular dependencies with the UsersService.
   */

  public async getUserFromStripeCustomerId(stripeCustomerId: string): Promise<UserCluster.User | null> {
    return this.dbService.client.user.findFirst({
      where: { stripeCustomerId },
      include: UserCluster._validator.include,
    });
  }

  /*
   * Common Utility Functions
   */

  private findExpirationFromSubscription(subscription: Stripe.Subscription): Date {
    if (subscription.ended_at) {
      return new Date(subscription.ended_at * 1000);
    }
    return new Date(subscription.items.data[0].current_period_end * 1000);
  }

  private findCancelDateFromSubscription(subscription: Stripe.Subscription): Date | null {
    if (subscription.cancel_at) {
      return new Date(subscription.cancel_at * 1000);
    }
    return null;
  }
  private async isKnownStripeCustomerId(stripeCustomerId: string): Promise<boolean> {
    const user = await this.getUserFromStripeCustomerId(stripeCustomerId);
    if (user) {
      return true;
    }
    return false;
  }

  private getDefaultPriceId(planType: ScratchPlanType): string | null {
    const plans = getPlans(this.configService.getScratchEnvironment());

    for (const plan of plans) {
      if (plan.planType === planType) {
        return plan.stripePriceIds[0] ?? null;
      }
    }

    return null;
  }

  private getPlanTypeFromPriceId(priceId: string): ScratchPlanType | null {
    const plans = getPlans(this.configService.getScratchEnvironment());

    for (const plan of plans) {
      if (plan.stripePriceIds.includes(priceId)) {
        return plan.planType;
      }
    }

    return null;
  }

  private getPlanTypeFromSubscription(subscription: Stripe.Subscription): string | null {
    WSLogger.debug({
      source: StripePaymentService.name,
      message: `Getting product id from subscription`,
      subscriptionId: subscription.id,
    });
    const firstItem = subscription.items?.data[0];

    if (!firstItem) {
      return null;
    }

    const priceId = firstItem.price?.id;
    WSLogger.debug({
      source: StripePaymentService.name,
      message: `Getting product type from subscription`,
      priceId,
      metadata: firstItem.metadata,
    });

    if (!priceId) {
      return null;
    }

    const planType = this.getPlanTypeFromPriceId(priceId);
    if (!planType) {
      WSLogger.warn({
        source: StripePaymentService.name,
        message: `No product type found for price id`,
        priceId,
      });
    }

    return planType;
  }

  private findPriceInDollarsForSubscription(subscription: Stripe.Subscription): number | undefined {
    for (const subscriptionItem of subscription.items.data) {
      const price = subscriptionItem.plan.amount;
      if (price && subscriptionItem.plan.currency === 'usd') {
        // Value comes in cents! We want to store dollars.
        return Math.floor(price / 100);
      }
    }
    return undefined;
  }
}
