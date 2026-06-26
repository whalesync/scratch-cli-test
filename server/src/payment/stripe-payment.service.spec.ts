/* eslint-disable @typescript-eslint/unbound-method */
/* eslint-disable @typescript-eslint/no-unsafe-assignment -- expect.objectContaining() returns any */
import { ScratchPlanType } from '@spinner/shared-types';
import { AuditLogService } from 'src/audit/audit-log.service';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { UserCluster } from 'src/db/cluster-types';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { PostHogService } from 'src/posthog/posthog.service';
import { SlackNotificationService } from 'src/slack/slack-notification.service';
import { ErrorCode, isErr, isOk } from 'src/types/results';
import Stripe from 'stripe';
import { TEST_SANDBOX_PLANS } from './plans';
import { StripePaymentService } from './stripe-payment.service';

// Valid test price ID from plans.ts
const VALID_TEST_PRICE_ID = TEST_SANDBOX_PLANS[0].stripePriceIds[0];
const VALID_TEST_PRO_PLAN_PRICE_ID =
  TEST_SANDBOX_PLANS.find((p) => p.planType === ScratchPlanType.PRO_PLAN)?.stripePriceIds[0] ||
  'price_1SYU4jBdRE0kMHNq4mMMjgWH';

import { UserRole } from '@prisma/client';

// Mock dependencies
const mockConfigService = {
  getStripeApiKey: jest.fn().mockReturnValue('sk_test_mock_key'),
  getStripeWebhookSecret: jest.fn().mockReturnValue('whsec_mock_secret'),
  getScratchEnvironment: jest.fn().mockReturnValue('test'),
  getTrialRequirePaymentMethod: jest.fn().mockReturnValue(false),
  isProductionEnvironment: jest.fn().mockReturnValue(false),
};

const mockDbService = {
  client: {
    user: {
      update: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    subscription: {
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({ id: 'sub_db_audit' }),
    },
    invoiceResult: {
      create: jest.fn(),
    },
  },
} as unknown as jest.Mocked<DbService>;

const mockPostHogService = {
  trackTrialStarted: jest.fn(),
  trackSubscriptionChanged: jest.fn(),
  trackSubscriptionCancelled: jest.fn(),
} as unknown as PostHogService;

const mockSlackNotificationService = {
  sendMessage: jest.fn().mockResolvedValue(undefined),
} as unknown as SlackNotificationService;

const mockAuditLogService = {
  logEvent: jest.fn().mockResolvedValue(undefined),
} as unknown as AuditLogService;

// Helper to create mock user

interface MockUser {
  id: string;
  email: string | null;
  name: string | null;
  clerkId: string | null;
  stripeCustomerId: string | null;
  organizationId: string | null;
  role: UserRole;
  settings: null;
  createdAt: Date;
  updatedAt: Date;
  lastWorkbookId: string | null;
  waitlistApproved: boolean;
  apiTokens: {
    type: string;
    id: string;
    createdAt: Date;
    userId: string;
    token: string;
    expiresAt: Date;
    scopes: string[];
  }[];
  workspacePermissions: {
    id: string;
    createdAt: Date;
    updatedAt: Date;
    role: string;
    userId: string;
    workbookId: string;
  }[];
  organization: { id: string; subscriptions: unknown[] } | null;
  [key: string]: unknown;
}

function createMockUser(overrides?: Partial<MockUser>): UserCluster.User {
  const user: MockUser = {
    id: 'usr_test123',
    email: 'test@example.com',
    name: 'Test User',
    clerkId: 'clerk_123',
    stripeCustomerId: overrides?.stripeCustomerId ?? null,
    organizationId: overrides?.organizationId ?? 'org_123',
    role: UserRole.USER,
    settings: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    lastWorkbookId: null,
    waitlistApproved: true,
    apiTokens: [],
    workspacePermissions: [],
    organization: overrides?.organization ?? {
      id: 'org_123',
      subscriptions: [],
    },
    ...overrides,
  };
  return user as unknown as UserCluster.User;
}

describe('StripePaymentService', () => {
  let service: StripePaymentService;
  let mockStripeInstance: jest.Mocked<Stripe>;

  beforeEach(() => {
    jest.clearAllMocks();

    // Set APP_ENV for tests that access scratchConfigService.getClientBaseUrl()
    process.env.APP_ENV = 'test';

    // Suppress WSLogger output during tests
    jest.spyOn(WSLogger, 'info').mockImplementation(() => {});
    jest.spyOn(WSLogger, 'debug').mockImplementation(() => {});
    jest.spyOn(WSLogger, 'error').mockImplementation(() => {});
    jest.spyOn(WSLogger, 'warn').mockImplementation(() => {});

    service = new StripePaymentService(
      mockConfigService as unknown as ScratchConfigService,
      mockDbService,
      mockPostHogService,
      mockSlackNotificationService,
      mockAuditLogService,
    );

    // Access private stripe instance for mocking
    mockStripeInstance = (service as unknown as Record<string, unknown>).stripe as jest.Mocked<Stripe>;
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.APP_ENV;
  });

  describe('generateNewCustomerId', () => {
    it('should create a new Stripe customer with user details', async () => {
      const user = createMockUser({ name: 'John Doe', email: 'john@example.com' });
      const mockCustomer = { id: 'cus_newCustomer123' } as Stripe.Customer;

      mockStripeInstance.customers.create = jest.fn().mockResolvedValue(mockCustomer);

      const result = await service.generateNewCustomerId(user);

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.v).toBe('cus_newCustomer123');
      }

      expect(mockStripeInstance.customers.create).toHaveBeenCalledWith({
        name: 'John Doe',
        email: 'john@example.com',
        metadata: {
          source: 'scratch',
          internal_id: 'usr_test123',
          environment: 'test',
        },
      });
    });

    it('should handle empty name and email', async () => {
      const user = createMockUser({ name: null, email: null });
      const mockCustomer = { id: 'cus_newCustomer456' } as Stripe.Customer;

      mockStripeInstance.customers.create = jest.fn().mockResolvedValue(mockCustomer);

      const result = await service.generateNewCustomerId(user);

      expect(isOk(result)).toBe(true);
      expect(mockStripeInstance.customers.create).toHaveBeenCalledWith({
        name: '',
        email: undefined,
        metadata: {
          source: 'scratch',
          internal_id: 'usr_test123',
          environment: 'test',
        },
      });
    });

    it('should return error when Stripe API fails', async () => {
      const user = createMockUser();
      const stripeError = new Error('Stripe API error');

      mockStripeInstance.customers.create = jest.fn().mockRejectedValue(stripeError);

      const result = await service.generateNewCustomerId(user);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.code).toBe(ErrorCode.StripeLibraryError);
        expect(result.error).toContain('Failed to generate new customer');
      }
    });

    it('should handle special characters in user data', async () => {
      const user = createMockUser({ name: 'Test & User <script>', email: 'test+tag@example.com' });
      const mockCustomer = { id: 'cus_special123' } as Stripe.Customer;

      mockStripeInstance.customers.create = jest.fn().mockResolvedValue(mockCustomer);

      const result = await service.generateNewCustomerId(user);

      expect(isOk(result)).toBe(true);
      expect(mockStripeInstance.customers.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Test & User <script>',
          email: 'test+tag@example.com',
        }),
      );
    });
  });

  describe('createTrialSubscription', () => {
    it('should create trial subscription for new user', async () => {
      const user = createMockUser({ stripeCustomerId: 'cus_existing123' });
      const mockSubscription = {
        id: 'sub_trial123',
        status: 'trialing',
        customer: 'cus_existing123',
        metadata: { application: 'scratch', planType: ScratchPlanType.PRO_PLAN },
        items: {
          data: [
            {
              price: { id: VALID_TEST_PRICE_ID },
              current_period_end: Math.floor(Date.now() / 1000) + 86400 * 7,
              plan: { amount: 1000, currency: 'usd' },
            },
          ],
        },
      } as unknown as Stripe.Subscription;

      mockStripeInstance.subscriptions.create = jest.fn().mockResolvedValue(mockSubscription);
      (mockDbService.client.subscription.upsert as jest.Mock).mockResolvedValue({});

      const result = await service.createTrialSubscription(user, ScratchPlanType.PRO_PLAN);

      expect(isOk(result)).toBe(true);
      expect(mockStripeInstance.subscriptions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_existing123',
          trial_period_days: 14,
          metadata: expect.objectContaining({
            application: 'scratch',
            planType: ScratchPlanType.PRO_PLAN,
            environment: 'test',
          }),
        }),
      );
      expect(mockPostHogService.trackTrialStarted).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'usr_test123' }),
        ScratchPlanType.PRO_PLAN,
      );
    });

    it('should refuse to start a trial when the user already has a subscription', async () => {
      const user = createMockUser({
        stripeCustomerId: 'cus_existing123',
        organization: {
          id: 'org_123',
          subscriptions: [{ id: 'sub_prior', userId: 'usr_test123', stripeStatus: 'canceled' }],
        },
      });

      mockStripeInstance.subscriptions.create = jest.fn();

      const result = await service.createTrialSubscription(user, ScratchPlanType.PRO_PLAN);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.code).toBe(ErrorCode.BadRequestError);
        expect(result.error).toContain('already has a subscription');
      }
      expect(mockStripeInstance.subscriptions.create).not.toHaveBeenCalled();
    });

    it('should write a trial-started audit-log entry', async () => {
      const user = createMockUser({ stripeCustomerId: 'cus_existing123' });
      const mockSubscription = {
        id: 'sub_trialaudit',
        status: 'trialing',
        customer: 'cus_existing123',
        metadata: { application: 'scratch', planType: ScratchPlanType.PRO_PLAN },
        items: {
          data: [
            {
              price: { id: VALID_TEST_PRICE_ID },
              current_period_end: Math.floor(Date.now() / 1000) + 86400 * 14,
              plan: { amount: 1000, currency: 'usd' },
            },
          ],
        },
      } as unknown as Stripe.Subscription;

      mockStripeInstance.subscriptions.create = jest.fn().mockResolvedValue(mockSubscription);
      (mockDbService.client.subscription.upsert as jest.Mock).mockResolvedValue({});
      (mockDbService.client.subscription.findUnique as jest.Mock).mockResolvedValueOnce({ id: 'sub_db_audit' });

      const result = await service.createTrialSubscription(user, ScratchPlanType.PRO_PLAN);

      expect(isOk(result)).toBe(true);
      expect(mockAuditLogService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'create',
          message: expect.stringContaining('trial'),
          entityId: 'sub_db_audit',
        }),
      );
    });

    it('should create new customer if user does not have one', async () => {
      const user = createMockUser({ stripeCustomerId: null });
      const mockCustomer = { id: 'cus_newCustomer789' } as Stripe.Customer;
      const mockSubscription = {
        id: 'sub_trial456',
        status: 'trialing',
        customer: 'cus_newCustomer789',
        metadata: { application: 'scratch', planType: ScratchPlanType.PRO_PLAN },
        items: {
          data: [
            {
              price: { id: VALID_TEST_PRICE_ID },
              current_period_end: Math.floor(Date.now() / 1000) + 86400 * 7,
              plan: { amount: 1000, currency: 'usd' },
            },
          ],
        },
      } as unknown as Stripe.Subscription;

      mockStripeInstance.customers.create = jest.fn().mockResolvedValue(mockCustomer);
      mockStripeInstance.subscriptions.create = jest.fn().mockResolvedValue(mockSubscription);
      (mockDbService.client.user.update as jest.Mock).mockResolvedValue({});
      (mockDbService.client.subscription.upsert as jest.Mock).mockResolvedValue({});

      const result = await service.createTrialSubscription(user, ScratchPlanType.PRO_PLAN);

      expect(isOk(result)).toBe(true);
      expect(mockDbService.client.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'usr_test123' },
          data: { stripeCustomerId: 'cus_newCustomer789' },
        }),
      );
    });

    it('should return error when Stripe subscription creation fails', async () => {
      const user = createMockUser({ stripeCustomerId: 'cus_existing123' });
      const stripeError = new Error('Subscription creation failed');

      mockStripeInstance.subscriptions.create = jest.fn().mockRejectedValue(stripeError);

      const result = await service.createTrialSubscription(user, ScratchPlanType.PRO_PLAN);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.code).toBe(ErrorCode.StripeLibraryError);
        expect(result.error).toContain('Failed to create trial subscription');
      }
    });
  });

  describe('ensureWhalesyncPlanSubscription', () => {
    it('creates a $0 Whalesync subscription when the organization has no active subscription', async () => {
      const user = createMockUser({
        id: 'usr_shadow',
        organizationId: 'org_shadow',
        organization: { id: 'org_shadow', subscriptions: [] },
      });
      (mockDbService.client.subscription.create as jest.Mock).mockResolvedValue({ id: 'sub_whalesync' });

      await service.ensureWhalesyncPlanSubscription(user);

      expect(mockDbService.client.subscription.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            userId: 'usr_shadow',
            organizationId: 'org_shadow',
            planType: ScratchPlanType.WHALESYNC_PLAN,
            // Deterministic synthetic id (no Stripe) keyed on the organization.
            stripeSubscriptionId: 'whalesync_org_shadow',
            priceInDollars: 0,
            stripeStatus: 'active',
            cancelAt: null,
            lastInvoicePaid: true,
          }),
        }),
      );

      // Expiry is effectively permanent (~100 years out).
      const createCalls = (mockDbService.client.subscription.create as jest.Mock).mock.calls as Array<
        [{ data: { expiration: Date } }]
      >;
      const createdExpiration = createCalls[0][0].data.expiration;
      expect(createdExpiration.getFullYear()).toBeGreaterThanOrEqual(new Date().getFullYear() + 99);

      expect(mockPostHogService.trackSubscriptionChanged).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'usr_shadow' }),
        ScratchPlanType.FREE_PLAN,
        ScratchPlanType.WHALESYNC_PLAN,
      );
      expect(mockAuditLogService.logEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'create',
          message: expect.stringContaining('Whalesync'),
          entityId: 'sub_whalesync',
        }),
      );
    });

    it('is a no-op when the organization already has an active subscription (never downgrades a paid plan)', async () => {
      const futureDate = new Date(Date.now() + 86400000);
      const user = createMockUser({
        id: 'usr_paid',
        organizationId: 'org_paid',
        organization: {
          id: 'org_paid',
          subscriptions: [{ id: 'sub_pro', userId: 'usr_paid', expiration: futureDate, stripeStatus: 'active' }],
        },
      });

      await service.ensureWhalesyncPlanSubscription(user);

      expect(mockDbService.client.subscription.create).not.toHaveBeenCalled();
      expect(mockAuditLogService.logEvent).not.toHaveBeenCalled();
    });

    it('is a no-op when the user has no organization', async () => {
      const user = createMockUser({ id: 'usr_noorg', organizationId: null, organization: null });

      await service.ensureWhalesyncPlanSubscription(user);

      expect(mockDbService.client.subscription.create).not.toHaveBeenCalled();
    });
  });

  describe('generateCheckoutUrl', () => {
    it('should generate checkout URL for user without active subscription', async () => {
      const user = createMockUser({
        stripeCustomerId: 'cus_checkout123',
        organization: { id: 'org_123', subscriptions: [] },
      });

      const mockSession = {
        id: 'cs_test123',
        url: 'https://checkout.stripe.com/pay/cs_test123',
      } as Stripe.Checkout.Session;

      mockStripeInstance.checkout.sessions.create = jest.fn().mockResolvedValue(mockSession);
      jest.spyOn(ScratchConfigService, 'getClientBaseUrl').mockReturnValue('https://app.scratch.md');

      const result = await service.generateCheckoutUrl(user, ScratchPlanType.PRO_PLAN, true);

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.v).toBe('https://checkout.stripe.com/pay/cs_test123');
      }

      expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'subscription',
          customer: 'cus_checkout123',
          success_url: 'https://app.scratch.md/billing?welcome',
          cancel_url: 'https://app.scratch.md/billing',
          line_items: expect.arrayContaining([
            expect.objectContaining({
              price: VALID_TEST_PRO_PLAN_PRICE_ID,
              quantity: 1,
            }),
          ]),
          subscription_data: expect.objectContaining({
            trial_period_days: 14,
            trial_settings: expect.objectContaining({
              end_behavior: expect.objectContaining({
                missing_payment_method: 'cancel',
              }),
            }),
            metadata: expect.objectContaining({
              application: 'scratch',
              planType: ScratchPlanType.PRO_PLAN,
              environment: 'test',
            }),
          }),
          payment_method_collection: 'if_required',
          automatic_tax: { enabled: false },
          customer_update: { address: 'auto', name: 'auto' },
          tax_id_collection: { enabled: true },
          allow_promotion_codes: true,
        }),
        expect.objectContaining({
          apiVersion: expect.any(String),
        }),
      );
    });

    it('should use the supplied returnPath and cancelPath (desktop billing return flow)', async () => {
      const user = createMockUser({
        stripeCustomerId: 'cus_desktop123',
        organization: { id: 'org_123', subscriptions: [] },
      });

      const mockSession = {
        id: 'cs_desktop123',
        url: 'https://checkout.stripe.com/pay/cs_desktop123',
      } as Stripe.Checkout.Session;

      mockStripeInstance.checkout.sessions.create = jest.fn().mockResolvedValue(mockSession);
      jest.spyOn(ScratchConfigService, 'getClientBaseUrl').mockReturnValue('https://app.scratch.md');

      const result = await service.generateCheckoutUrl(
        user,
        ScratchPlanType.PRO_PLAN,
        false,
        '/billing/desktop-return?status=success',
        '/billing/desktop-return?status=cancel',
      );

      expect(isOk(result)).toBe(true);
      expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          success_url: 'https://app.scratch.md/billing/desktop-return?status=success',
          cancel_url: 'https://app.scratch.md/billing/desktop-return?status=cancel',
        }),
        expect.objectContaining({ apiVersion: expect.any(String) }),
      );
    });

    it('should generate checkout URL without trial when createTrialSubscription is false', async () => {
      const user = createMockUser({
        stripeCustomerId: 'cus_notrial123',
        organization: { id: 'org_123', subscriptions: [] },
      });

      const mockSession = {
        id: 'cs_notrial123',
        url: 'https://checkout.stripe.com/pay/cs_notrial123',
      } as Stripe.Checkout.Session;

      mockStripeInstance.checkout.sessions.create = jest.fn().mockResolvedValue(mockSession);
      jest.spyOn(ScratchConfigService, 'getClientBaseUrl').mockReturnValue('https://app.scratch.md');

      const result = await service.generateCheckoutUrl(user, ScratchPlanType.PRO_PLAN, false);

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.v).toBe('https://checkout.stripe.com/pay/cs_notrial123');
      }

      expect(mockStripeInstance.checkout.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'subscription',
          customer: 'cus_notrial123',
          line_items: expect.arrayContaining([
            expect.objectContaining({
              price: VALID_TEST_PRO_PLAN_PRICE_ID,
              quantity: 1,
            }),
          ]),
          subscription_data: expect.objectContaining({
            trial_period_days: undefined,
            trial_settings: undefined,
            metadata: expect.objectContaining({
              application: 'scratch',
              planType: ScratchPlanType.PRO_PLAN,
              environment: 'test',
            }),
          }),
          payment_method_collection: 'always',
          automatic_tax: { enabled: false },
          customer_update: { address: 'auto', name: 'auto' },
          tax_id_collection: { enabled: true },
          allow_promotion_codes: true,
          success_url: 'https://app.scratch.md/billing?welcome',
          cancel_url: 'https://app.scratch.md/billing',
        }),
        expect.objectContaining({
          apiVersion: expect.any(String),
        }),
      );
    });

    it('should redirect to portal if user already has active subscription', async () => {
      const futureDate = new Date(Date.now() + 86400000);
      const user = createMockUser({
        stripeCustomerId: 'cus_existing123',
        organization: {
          id: 'org_123',
          subscriptions: [
            {
              id: 'sub_active',
              userId: 'usr_test123',
              expiration: futureDate,
              stripeStatus: 'active',
            },
          ],
        },
      });

      const mockPortalSession = {
        url: 'https://billing.stripe.com/session/test123',
      } as Stripe.BillingPortal.Session;

      mockStripeInstance.billingPortal.sessions.create = jest.fn().mockResolvedValue(mockPortalSession);
      const checkoutCreateSpy = jest.fn();
      mockStripeInstance.checkout.sessions.create = checkoutCreateSpy;

      const result = await service.generateCheckoutUrl(user, ScratchPlanType.PRO_PLAN, true);

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.v).toBe('https://billing.stripe.com/session/test123');
      }

      // Should create portal session, not checkout session
      expect(mockStripeInstance.billingPortal.sessions.create).toHaveBeenCalled();
      expect(checkoutCreateSpy).not.toHaveBeenCalled();
    });

    it('should return error for unknown product type', async () => {
      const user = createMockUser({
        stripeCustomerId: 'cus_test123',
        organization: { id: 'org_123', subscriptions: [] },
      });

      const result = await service.generateCheckoutUrl(user, 'unknown_plan' as ScratchPlanType);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.code).toBe(ErrorCode.UnexpectedError);
        expect(result.error).toContain('No stripe product id for unknown_plan');
      }
    });

    it('should return error when checkout session has no URL', async () => {
      const user = createMockUser({
        stripeCustomerId: 'cus_nourl123',
        organization: { id: 'org_123', subscriptions: [] },
      });

      const mockSession = { id: 'cs_nourl', url: null } as unknown as Stripe.Checkout.Session;

      mockStripeInstance.checkout.sessions.create = jest.fn().mockResolvedValue(mockSession);

      const result = await service.generateCheckoutUrl(user, ScratchPlanType.PRO_PLAN, true);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.code).toBe(ErrorCode.StripeLibraryError);
        expect(result.error).toContain('No URL returned from Stripe');
      }
    });
  });

  describe('createCustomerPortalUrl', () => {
    it('should create portal URL for subscription owner', async () => {
      const futureDate = new Date(Date.now() + 86400000);
      const user = createMockUser({
        stripeCustomerId: 'cus_portal123',
        organization: {
          id: 'org_123',
          subscriptions: [
            {
              id: 'sub_active',
              userId: 'usr_test123',
              expiration: futureDate,
              stripeStatus: 'active',
            },
          ],
        },
      });

      const mockPortalSession = {
        url: 'https://billing.stripe.com/session/portal123',
      } as Stripe.BillingPortal.Session;

      mockStripeInstance.billingPortal.sessions.create = jest.fn().mockResolvedValue(mockPortalSession);
      jest.spyOn(ScratchConfigService, 'getClientBaseUrl').mockReturnValue('https://app.scratch.md');

      const result = await service.createCustomerPortalUrl(user, {});

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.v).toBe('https://billing.stripe.com/session/portal123');
      }

      expect(mockStripeInstance.billingPortal.sessions.create).toHaveBeenCalledWith(
        {
          customer: 'cus_portal123',
          return_url: 'https://app.scratch.md/billing',
        },
        expect.objectContaining({
          apiVersion: expect.any(String),
        }),
      );
    });

    it('should use the supplied returnPath (desktop billing return flow)', async () => {
      const futureDate = new Date(Date.now() + 86400000);
      const user = createMockUser({
        stripeCustomerId: 'cus_portaldesktop',
        organization: {
          id: 'org_123',
          subscriptions: [
            {
              id: 'sub_active',
              userId: 'usr_test123',
              expiration: futureDate,
              stripeStatus: 'active',
            },
          ],
        },
      });

      const mockPortalSession = {
        url: 'https://billing.stripe.com/session/desktop',
      } as Stripe.BillingPortal.Session;

      mockStripeInstance.billingPortal.sessions.create = jest.fn().mockResolvedValue(mockPortalSession);
      jest.spyOn(ScratchConfigService, 'getClientBaseUrl').mockReturnValue('https://app.scratch.md');

      const result = await service.createCustomerPortalUrl(user, { returnPath: '/billing/desktop-return' });

      expect(isOk(result)).toBe(true);
      expect(mockStripeInstance.billingPortal.sessions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          customer: 'cus_portaldesktop',
          return_url: 'https://app.scratch.md/billing/desktop-return',
        }),
        expect.objectContaining({ apiVersion: expect.any(String) }),
      );
    });

    it('should return error if user does not own active subscription', async () => {
      const futureDate = new Date(Date.now() + 86400000);
      const user = createMockUser({
        id: 'usr_notowner',
        stripeCustomerId: 'cus_notowner123',
        organization: {
          id: 'org_123',
          subscriptions: [
            {
              id: 'sub_active',
              userId: 'usr_different',
              expiration: futureDate,
              stripeStatus: 'active',
            },
          ],
        },
      });

      const result = await service.createCustomerPortalUrl(user, {});

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.code).toBe(ErrorCode.BadRequestError);
        expect(result.error).toContain('You do not own the active subscription');
      }
    });

    it('should return error if user has no active subscriptions', async () => {
      const user = createMockUser({
        stripeCustomerId: 'cus_noactive123',
        organization: {
          id: 'org_123',
          subscriptions: [],
        },
      });

      const result = await service.createCustomerPortalUrl(user, {});

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.code).toBe(ErrorCode.BadRequestError);
      }
    });
  });

  describe('handleWebhookCallback', () => {
    it('should successfully process valid webhook signature', async () => {
      const requestBody = JSON.stringify({ type: 'customer.subscription.updated' });
      const signatureHeader = 'valid_signature';
      const mockEvent = {
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_webhook123',
            customer: 'cus_webhook123',
            status: 'active',
            metadata: { application: 'scratch', planType: ScratchPlanType.PRO_PLAN },
            items: {
              data: [
                {
                  price: { id: VALID_TEST_PRICE_ID },
                  current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
                  plan: { amount: 1000, currency: 'usd' },
                },
              ],
            },
          } as unknown as Stripe.Subscription,
        },
      } as Stripe.Event;

      mockStripeInstance.webhooks.constructEvent = jest.fn().mockReturnValue(mockEvent);
      mockStripeInstance.subscriptions.retrieve = jest.fn().mockResolvedValue(mockEvent.data.object);
      (mockDbService.client.user.findFirst as jest.Mock).mockResolvedValue(
        createMockUser({ stripeCustomerId: 'cus_webhook123' }),
      );
      (mockDbService.client.subscription.upsert as jest.Mock).mockResolvedValue({});

      const result = await service.handleWebhookCallback(requestBody, signatureHeader);

      expect(isOk(result)).toBe(true);
      expect(mockStripeInstance.webhooks.constructEvent).toHaveBeenCalledWith(
        requestBody,
        signatureHeader,
        'whsec_mock_secret',
      );
    });

    it('should return unauthorized error for invalid signature', async () => {
      const requestBody = JSON.stringify({ type: 'test' });
      const signatureHeader = 'invalid_signature';

      mockStripeInstance.webhooks.constructEvent = jest.fn().mockImplementation(() => {
        throw new Error('Invalid signature');
      });

      const result = await service.handleWebhookCallback(requestBody, signatureHeader);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.code).toBe(ErrorCode.UnauthorizedError);
        expect(result.error).toContain('Webhook signature verification failed');
      }
    });

    it('should ignore unhandled event types', async () => {
      const requestBody = JSON.stringify({ type: 'invoice.created' });
      const signatureHeader = 'valid_signature';
      const mockEvent = {
        type: 'invoice.created',
        data: { object: {} },
      } as Stripe.Event;

      mockStripeInstance.webhooks.constructEvent = jest.fn().mockReturnValue(mockEvent);

      const result = await service.handleWebhookCallback(requestBody, signatureHeader);

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.v).toBe('success');
      }
    });

    it('should handle checkout.session.completed event', async () => {
      const requestBody = JSON.stringify({ type: 'checkout.session.completed' });
      const signatureHeader = 'valid_signature';
      const mockEvent = {
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_checkout123',
            subscription: 'sub_checkout123',
          } as Stripe.Checkout.Session,
        },
      } as Stripe.Event;

      mockStripeInstance.webhooks.constructEvent = jest.fn().mockReturnValue(mockEvent);
      mockStripeInstance.subscriptions.retrieve = jest.fn().mockResolvedValue({
        id: 'sub_checkout123',
        customer: 'cus_checkout123',
        status: 'active',
        metadata: { application: 'scratch', planType: ScratchPlanType.PRO_PLAN, environment: 'test' },
        items: {
          data: [
            {
              price: { id: VALID_TEST_PRICE_ID },
              current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
              plan: { amount: 1000, currency: 'usd' },
            },
          ],
        },
      } as unknown as Stripe.Subscription);
      // Need to mock findFirst multiple times - for isKnownStripeCustomerId and getUserFromStripeCustomerId
      (mockDbService.client.user.findFirst as jest.Mock)
        .mockResolvedValueOnce(createMockUser({ stripeCustomerId: 'cus_checkout123' }))
        .mockResolvedValueOnce(createMockUser({ stripeCustomerId: 'cus_checkout123' }));
      (mockDbService.client.subscription.upsert as jest.Mock).mockResolvedValue({});

      const result = await service.handleWebhookCallback(requestBody, signatureHeader);

      expect(isOk(result)).toBe(true);
    });

    it('should handle invoice.paid event', async () => {
      const requestBody = JSON.stringify({ type: 'invoice.paid' });
      const signatureHeader = 'valid_signature';
      const mockEvent = {
        type: 'invoice.paid',
        data: {
          object: {
            id: 'in_paid123',
            customer: 'cus_paid123',
            lines: {
              data: [
                {
                  metadata: { application: 'scratch' },
                  parent: {
                    type: 'subscription_item_details',
                    subscription_item_details: {
                      subscription: 'sub_paid123',
                    },
                  },
                },
              ],
            },
          } as unknown as Stripe.Invoice,
        },
      } as Stripe.Event;

      mockStripeInstance.webhooks.constructEvent = jest.fn().mockReturnValue(mockEvent);
      mockStripeInstance.subscriptions.retrieve = jest.fn().mockResolvedValue({
        id: 'sub_paid123',
        customer: 'cus_paid123',
        status: 'active',
        metadata: { application: 'scratch', planType: ScratchPlanType.PRO_PLAN, environment: 'test' },
        items: {
          data: [
            {
              price: { id: VALID_TEST_PRICE_ID },
              current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
              plan: { amount: 1000, currency: 'usd' },
            },
          ],
        },
      } as unknown as Stripe.Subscription);
      // Need to mock findFirst multiple times - for isKnownStripeCustomerId, getUserFromStripeCustomerId (in upsertSubscription), and getUserFromStripeCustomerId (in handleInvoicePaid)
      (mockDbService.client.user.findFirst as jest.Mock)
        .mockResolvedValueOnce(createMockUser({ stripeCustomerId: 'cus_paid123', organizationId: 'org_paid' }))
        .mockResolvedValueOnce(createMockUser({ stripeCustomerId: 'cus_paid123', organizationId: 'org_paid' }))
        .mockResolvedValueOnce(createMockUser({ stripeCustomerId: 'cus_paid123', organizationId: 'org_paid' }));
      (mockDbService.client.subscription.upsert as jest.Mock).mockResolvedValue({});
      (mockDbService.client.invoiceResult.create as jest.Mock).mockResolvedValue({});

      const result = await service.handleWebhookCallback(requestBody, signatureHeader);

      expect(isOk(result)).toBe(true);
      expect(mockDbService.client.invoiceResult.create).toHaveBeenCalled();
    });

    it('should handle invoice.payment_failed event', async () => {
      const requestBody = JSON.stringify({ type: 'invoice.payment_failed' });
      const signatureHeader = 'valid_signature';
      const mockEvent = {
        type: 'invoice.payment_failed',
        data: {
          object: {
            id: 'in_failed123',
            lines: {
              data: [
                {
                  subscription: 'sub_failed123',
                },
              ],
            },
          } as Stripe.Invoice,
        },
      } as Stripe.Event;

      mockStripeInstance.webhooks.constructEvent = jest.fn().mockReturnValue(mockEvent);
      mockStripeInstance.subscriptions.retrieve = jest.fn().mockResolvedValue({
        id: 'sub_failed123',
        customer: 'cus_failed123',
        status: 'past_due',
        metadata: { application: 'scratch', planType: ScratchPlanType.PRO_PLAN, environment: 'test' },
        items: {
          data: [
            {
              price: { id: VALID_TEST_PRICE_ID },
              current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
              plan: { amount: 1000, currency: 'usd' },
            },
          ],
        },
      } as unknown as Stripe.Subscription);
      (mockDbService.client.subscription.update as jest.Mock).mockResolvedValue({});

      const result = await service.handleWebhookCallback(requestBody, signatureHeader);

      expect(isOk(result)).toBe(true);
      expect(mockDbService.client.subscription.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { stripeSubscriptionId: 'sub_failed123' },
          data: { lastInvoicePaid: false },
        }),
      );
    });
  });

  describe('getUserFromStripeCustomerId', () => {
    it('should return user when found', async () => {
      const mockUser = createMockUser({ stripeCustomerId: 'cus_found123' });
      (mockDbService.client.user.findFirst as jest.Mock).mockReset();
      (mockDbService.client.user.findFirst as jest.Mock).mockResolvedValue(mockUser);

      const result = await service.getUserFromStripeCustomerId('cus_found123');

      expect(result).toEqual(mockUser);
      expect(mockDbService.client.user.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { stripeCustomerId: 'cus_found123' },
        }),
      );
    });

    it('should return null when user not found', async () => {
      (mockDbService.client.user.findFirst as jest.Mock).mockReset();
      (mockDbService.client.user.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.getUserFromStripeCustomerId('cus_notfound123');

      expect(result).toBeNull();
    });
  });

  describe('upsertSubscription', () => {
    it('should upsert subscription successfully', async () => {
      const mockSubscription = {
        id: 'sub_upsert123',
        customer: 'cus_upsert123',
        status: 'active',
        metadata: { application: 'scratch', planType: ScratchPlanType.PRO_PLAN, environment: 'test' },
        items: {
          data: [
            {
              price: { id: VALID_TEST_PRICE_ID },
              current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
              plan: { amount: 1000, currency: 'usd' },
            },
          ],
        },
      } as unknown as Stripe.Subscription;

      // Need to mock findFirst twice - once for isKnownStripeCustomerId check, once for getUserFromStripeCustomerId
      (mockDbService.client.user.findFirst as jest.Mock)
        .mockResolvedValueOnce(createMockUser({ stripeCustomerId: 'cus_upsert123', organizationId: 'org_upsert' }))
        .mockResolvedValueOnce(createMockUser({ stripeCustomerId: 'cus_upsert123', organizationId: 'org_upsert' }));
      (mockDbService.client.subscription.upsert as jest.Mock).mockResolvedValue({});

      const result = await service.upsertSubscription('sub_upsert123', true, mockSubscription);

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.v).toBe('success');
      }

      expect(mockDbService.client.subscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { stripeSubscriptionId: 'sub_upsert123' },
          create: expect.objectContaining({
            userId: 'usr_test123',
            organizationId: 'org_upsert',
            stripeSubscriptionId: 'sub_upsert123',
            lastInvoicePaid: true,
            stripeStatus: 'active',
          }),
          update: expect.objectContaining({
            lastInvoicePaid: true,
            stripeStatus: 'active',
          }),
        }),
      );
    });

    it('should ignore non-scratch subscriptions', async () => {
      const mockSubscription = {
        id: 'sub_other123',
        customer: 'cus_other123',
        status: 'active',
        metadata: { application: 'other_app' },
        items: {
          data: [
            {
              price: { id: 'price_unknown' },
              current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
            },
          ],
        },
      } as unknown as Stripe.Subscription;

      const result = await service.upsertSubscription('sub_other123', undefined, mockSubscription);

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.v).toBe('ignored');
      }

      expect(mockDbService.client.subscription.upsert).not.toHaveBeenCalled();
    });

    it('should return ignored when user not known in non-production', async () => {
      const mockSubscription = {
        id: 'sub_nouser123',
        customer: 'cus_nouser123',
        status: 'active',
        metadata: { application: 'scratch', planType: ScratchPlanType.PRO_PLAN, environment: 'test' },
        items: {
          data: [
            {
              price: { id: VALID_TEST_PRICE_ID },
              current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
              plan: { amount: 1000, currency: 'usd' },
            },
          ],
        },
      } as unknown as Stripe.Subscription;

      (mockDbService.client.user.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.upsertSubscription('sub_nouser123', undefined, mockSubscription);

      // In non-production, the isKnownStripeCustomerId check returns ignored before reaching the
      // email-fallback path, so unknown Stripe customers from other environments don't fail webhooks.
      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.v).toBe('ignored');
      }
    });

    it('should back-fill stripeCustomerId via email match in production', async () => {
      mockConfigService.isProductionEnvironment.mockReturnValueOnce(true);

      const mockSubscription = {
        id: 'sub_backfill123',
        customer: 'cus_backfill123',
        status: 'active',
        metadata: { application: 'scratch', planType: ScratchPlanType.PRO_PLAN, environment: 'test' },
        items: {
          data: [
            {
              price: { id: VALID_TEST_PRICE_ID },
              current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
              plan: { amount: 1000, currency: 'usd' },
            },
          ],
        },
      } as unknown as Stripe.Subscription;

      // Direct stripeCustomerId lookup misses.
      (mockDbService.client.user.findFirst as jest.Mock).mockResolvedValueOnce(null);
      // Stripe returns a customer with an email we recognize.
      mockStripeInstance.customers.retrieve = jest.fn().mockResolvedValue({
        id: 'cus_backfill123',
        deleted: false,
        email: '  Curtis@Whalesync.com  ',
      });
      // Email lookup (normalized) finds the User row, which has no stripeCustomerId yet.
      const candidate = createMockUser({
        id: 'usr_backfill',
        email: 'curtis@whalesync.com',
        stripeCustomerId: null,
        organizationId: 'org_backfill',
      });
      (mockDbService.client.user.findUnique as jest.Mock).mockResolvedValueOnce(candidate);
      (mockDbService.client.user.update as jest.Mock).mockResolvedValueOnce({});
      (mockDbService.client.subscription.upsert as jest.Mock).mockResolvedValueOnce({});

      const result = await service.upsertSubscription('sub_backfill123', true, mockSubscription);

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.v).toBe('success');
      }
      expect(mockDbService.client.user.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { email: 'curtis@whalesync.com' } }),
      );
      expect(mockDbService.client.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'usr_backfill' },
          data: { stripeCustomerId: 'cus_backfill123' },
        }),
      );
      expect(mockDbService.client.subscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ userId: 'usr_backfill', organizationId: 'org_backfill' }),
        }),
      );
    });

    it('should ignore when email match has a different stripeCustomerId', async () => {
      mockConfigService.isProductionEnvironment.mockReturnValueOnce(true);

      const mockSubscription = {
        id: 'sub_conflict123',
        customer: 'cus_new123',
        status: 'active',
        metadata: { application: 'scratch', planType: ScratchPlanType.PRO_PLAN, environment: 'test' },
        items: {
          data: [
            {
              price: { id: VALID_TEST_PRICE_ID },
              current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
              plan: { amount: 1000, currency: 'usd' },
            },
          ],
        },
      } as unknown as Stripe.Subscription;

      (mockDbService.client.user.findFirst as jest.Mock).mockResolvedValueOnce(null);
      mockStripeInstance.customers.retrieve = jest.fn().mockResolvedValue({
        id: 'cus_new123',
        deleted: false,
        email: 'curtis@whalesync.com',
      });
      // Candidate already linked to a different Stripe customer — don't overwrite.
      (mockDbService.client.user.findUnique as jest.Mock).mockResolvedValueOnce(
        createMockUser({
          id: 'usr_conflict',
          email: 'curtis@whalesync.com',
          stripeCustomerId: 'cus_existing456',
          organizationId: 'org_conflict',
        }),
      );

      const result = await service.upsertSubscription('sub_conflict123', undefined, mockSubscription);

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.v).toBe('ignored');
      }
      expect(mockDbService.client.user.update).not.toHaveBeenCalled();
      expect(mockDbService.client.subscription.upsert).not.toHaveBeenCalled();
    });

    it('should return ignored when user has no organization', async () => {
      const mockSubscription = {
        id: 'sub_noorg123',
        customer: 'cus_noorg123',
        status: 'active',
        metadata: { application: 'scratch', planType: ScratchPlanType.PRO_PLAN, environment: 'test' },
        items: {
          data: [
            {
              price: { id: VALID_TEST_PRICE_ID },
              current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
              plan: { amount: 1000, currency: 'usd' },
            },
          ],
        },
      } as unknown as Stripe.Subscription;

      // In non-production, if user is not known, it returns "ignored" before checking organization
      // So we need to make sure the user is found but has no organization
      (mockDbService.client.user.findFirst as jest.Mock)
        .mockResolvedValueOnce(createMockUser({ stripeCustomerId: 'cus_noorg123', organizationId: null }))
        .mockResolvedValueOnce(createMockUser({ stripeCustomerId: 'cus_noorg123', organizationId: null }));

      const result = await service.upsertSubscription('sub_noorg123', undefined, mockSubscription);

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.v).toBe('ignored');
      }
    });

    it('should handle database errors gracefully', async () => {
      const mockSubscription = {
        id: 'sub_dberror123',
        customer: 'cus_dberror123',
        status: 'active',
        metadata: { application: 'scratch', planType: ScratchPlanType.PRO_PLAN, environment: 'test' },
        items: {
          data: [
            {
              price: { id: VALID_TEST_PRICE_ID },
              current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
              plan: { amount: 1000, currency: 'usd' },
            },
          ],
        },
      } as unknown as Stripe.Subscription;

      // Need to mock findFirst twice - once for isKnownStripeCustomerId check, once for getUserFromStripeCustomerId
      (mockDbService.client.user.findFirst as jest.Mock)
        .mockResolvedValueOnce(createMockUser({ stripeCustomerId: 'cus_dberror123', organizationId: 'org_dberror' }))
        .mockResolvedValueOnce(createMockUser({ stripeCustomerId: 'cus_dberror123', organizationId: 'org_dberror' }));
      (mockDbService.client.subscription.upsert as jest.Mock).mockRejectedValue(new Error('Database error'));

      const result = await service.upsertSubscription('sub_dberror123', undefined, mockSubscription);

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.code).toBe(ErrorCode.UnexpectedError);
        expect(result.error).toContain('Failed to upsert subscription');
      }
    });

    it('should fetch subscription from Stripe if not provided', async () => {
      const mockSubscription = {
        id: 'sub_fetch123',
        customer: 'cus_fetch123',
        status: 'active',
        metadata: { application: 'scratch', planType: ScratchPlanType.PRO_PLAN, environment: 'test' },
        items: {
          data: [
            {
              price: { id: VALID_TEST_PRICE_ID },
              current_period_end: Math.floor(Date.now() / 1000) + 86400 * 30,
              plan: { amount: 1000, currency: 'usd' },
            },
          ],
        },
      } as unknown as Stripe.Subscription;

      mockStripeInstance.subscriptions.retrieve = jest.fn().mockResolvedValue(mockSubscription);
      // Need to mock findFirst twice - once for isKnownStripeCustomerId check, once for getUserFromStripeCustomerId
      (mockDbService.client.user.findFirst as jest.Mock)
        .mockResolvedValueOnce(createMockUser({ stripeCustomerId: 'cus_fetch123', organizationId: 'org_fetch' }))
        .mockResolvedValueOnce(createMockUser({ stripeCustomerId: 'cus_fetch123', organizationId: 'org_fetch' }));
      (mockDbService.client.subscription.upsert as jest.Mock).mockResolvedValue({});

      const result = await service.upsertSubscription('sub_fetch123', undefined);

      expect(isOk(result)).toBe(true);
      expect(mockStripeInstance.subscriptions.retrieve).toHaveBeenCalledWith('sub_fetch123');
    });
  });
});
