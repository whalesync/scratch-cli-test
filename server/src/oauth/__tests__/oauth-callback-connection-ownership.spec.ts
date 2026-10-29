import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AuthType } from '@prisma/client';
import {
  OAuthStatePayload,
  ScratchPlanType,
  ValidatedOAuthInitiateOptionsDto,
  WorkbookId,
  WorkspacePermissionId,
} from '@spinner/shared-types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { Actor } from 'src/users/types';
import { DecryptedCredentials } from '../../remote-service/connector-account/types/encrypted-credentials.interface';
import { OAuthPendingAuthorizationStore } from '../oauth-pending-authorization-store.service';
import { OAuthProvider, OAuthTokenResponse } from '../oauth-provider.interface';
import { OAuthService } from '../oauth.service';
import { PendingOAuthAuthorization } from '../types';

/**
 * DEV-12155: the OAuth callback used to trust a `connectorAccountId` read from an unsigned,
 * browser-round-tripped state and overwrite that connection's tokens without checking whose it
 * was. These tests pin the fix: a re-auth can only ever land on an OAuth connection of the same
 * service inside the caller's permission-checked workbook, and the state is single-use and
 * tamper-evident. Every rejection must leave the victim connection's credentials untouched and
 * must happen before the authorization code is exchanged.
 */

const ATTACKER_USER_ID = 'usr_attacker';
const ATTACKER_ORGANIZATION_ID = 'org_attacker';
const ATTACKER_WORKBOOK_ID = 'wkb_attacker';
/** A second workbook in the attacker's own org that the attacker can also edit. */
const ATTACKER_SECOND_WORKBOOK_ID = 'wkb_attacker_second';
const VICTIM_WORKBOOK_ID = 'wkb_victim';

const VICTIM_CREDENTIALS: DecryptedCredentials = {
  oauthAccessToken: 'victim-access-token',
  oauthRefreshToken: 'victim-refresh-token',
};

interface FakeConnectorAccountRow {
  id: string;
  workbookId: string;
  service: string;
  authType: AuthType;
  extras: unknown;
  oauthAppVersion: number;
  encryptedCredentials: unknown;
  healthStatus: string | null;
}

function buildConnectorAccountRow(
  overrides: Partial<FakeConnectorAccountRow> & Pick<FakeConnectorAccountRow, 'id' | 'workbookId'>,
): FakeConnectorAccountRow {
  return {
    service: 'AIRTABLE',
    authType: AuthType.OAUTH,
    extras: null,
    oauthAppVersion: 1,
    encryptedCredentials: { ...VICTIM_CREDENTIALS },
    healthStatus: 'OK',
    ...overrides,
  };
}

/**
 * The connections every test starts from. Only `coa_attacker_own` is a legitimate re-auth
 * target for the attacker's main workbook.
 */
function buildSeedConnectorAccountRows(): FakeConnectorAccountRow[] {
  return [
    buildConnectorAccountRow({
      id: 'coa_attacker_own',
      workbookId: ATTACKER_WORKBOOK_ID,
      encryptedCredentials: { oauthAccessToken: 'old-own-access-token' },
    }),
    buildConnectorAccountRow({ id: 'coa_victim_other_org', workbookId: VICTIM_WORKBOOK_ID }),
    buildConnectorAccountRow({ id: 'coa_attacker_second_workbook', workbookId: ATTACKER_SECOND_WORKBOOK_ID }),
    buildConnectorAccountRow({ id: 'coa_notion_same_workbook', workbookId: ATTACKER_WORKBOOK_ID, service: 'NOTION' }),
    buildConnectorAccountRow({
      id: 'coa_api_key_same_workbook',
      workbookId: ATTACKER_WORKBOOK_ID,
      authType: AuthType.USER_PROVIDED_PARAMS,
    }),
    buildConnectorAccountRow({
      id: 'coa_salesforce_sandbox',
      workbookId: ATTACKER_WORKBOOK_ID,
      service: 'SALESFORCE',
      extras: { sandbox: true },
    }),
  ];
}

/**
 * A Prisma-shaped client over in-memory workbooks and connector accounts, exposing just the
 * queries the initiate/callback paths make. `$transaction` runs against the same rows.
 */
function buildFakeDbService() {
  const connectorAccountRows = buildSeedConnectorAccountRows();
  const workbookRows = [
    { id: ATTACKER_WORKBOOK_ID, organizationId: ATTACKER_ORGANIZATION_ID },
    { id: ATTACKER_SECOND_WORKBOOK_ID, organizationId: ATTACKER_ORGANIZATION_ID },
    { id: VICTIM_WORKBOOK_ID, organizationId: 'org_victim' },
  ];
  const advisoryLockQueries: string[] = [];
  const connectorAccountUpdates: { id: string; data: Record<string, unknown>; insideTransaction: boolean }[] = [];
  const connectorAccountCreates: Record<string, unknown>[] = [];

  const buildConnectorAccountUpdate =
    (insideTransaction: boolean) =>
    ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      connectorAccountUpdates.push({ id: where.id, data, insideTransaction });
      const row = connectorAccountRows.find((candidateRow) => candidateRow.id === where.id);
      if (!row) {
        return Promise.reject(new Error(`no connector account ${where.id}`));
      }
      Object.assign(row, data);
      return Promise.resolve({ ...row });
    };

  const transactionClient = {
    $queryRaw: (template: TemplateStringsArray, ...values: unknown[]) => {
      advisoryLockQueries.push(template.join('?') + JSON.stringify(values));
      return Promise.resolve([{ acquired: true }]);
    },
    connectorAccount: { update: buildConnectorAccountUpdate(true) },
  };

  const client = {
    $transaction: (callback: (tx: typeof transactionClient) => Promise<unknown>) => callback(transactionClient),
    workbook: {
      findFirst: ({ where }: { where: { id: string } }) =>
        Promise.resolve(workbookRows.find((workbookRow) => workbookRow.id === where.id) ?? null),
      findUniqueOrThrow: ({ where }: { where: { id: string } }) => {
        const workbookRow = workbookRows.find((candidateRow) => candidateRow.id === where.id);
        return workbookRow ? Promise.resolve(workbookRow) : Promise.reject(new Error(`no workbook ${where.id}`));
      },
    },
    connectorAccount: {
      findFirst: ({ where }: { where: { id: string; workbookId?: string } }) =>
        Promise.resolve(
          connectorAccountRows.find(
            (row) => row.id === where.id && (where.workbookId === undefined || row.workbookId === where.workbookId),
          ) ?? null,
        ),
      findUnique: ({ where }: { where: { id: string } }) =>
        Promise.resolve(connectorAccountRows.find((row) => row.id === where.id) ?? null),
      count: () => Promise.resolve(0),
      create: ({ data }: { data: Record<string, unknown> }) => {
        connectorAccountCreates.push(data);
        return Promise.resolve({ ...data });
      },
      update: buildConnectorAccountUpdate(false),
    },
  };

  return {
    db: { client } as never,
    connectorAccountRows,
    advisoryLockQueries,
    connectorAccountUpdates,
    connectorAccountCreates,
    findConnectorAccountRow: (connectorAccountId: string) =>
      connectorAccountRows.find((row) => row.id === connectorAccountId),
  };
}

/**
 * In-memory stand-in for the Redis-backed store with the same contract: records keyed by
 * userId + nonce, JSON round-tripped (as Redis does), consumed at most once.
 */
function buildInMemoryPendingAuthorizationStore() {
  const storedPendingAuthorizationJsonByKey = new Map<string, string>();
  let nonceCounter = 0;
  const keyFor = (userId: string, pendingAuthorizationNonce: string) => `${userId}:${pendingAuthorizationNonce}`;

  const store = {
    savePendingAuthorizationAndReturnNonce: jest.fn((pendingAuthorization: PendingOAuthAuthorization) => {
      nonceCounter += 1;
      const pendingAuthorizationNonce = `nonce-${nonceCounter}`;
      storedPendingAuthorizationJsonByKey.set(
        keyFor(pendingAuthorization.userId, pendingAuthorizationNonce),
        JSON.stringify(pendingAuthorization),
      );
      return Promise.resolve(pendingAuthorizationNonce);
    }),
    consumePendingAuthorizationForUser: jest.fn((userId: string, pendingAuthorizationNonce: string) => {
      const key = keyFor(userId, pendingAuthorizationNonce);
      const storedPendingAuthorizationJson = storedPendingAuthorizationJsonByKey.get(key);
      storedPendingAuthorizationJsonByKey.delete(key);
      return Promise.resolve(
        storedPendingAuthorizationJson
          ? (JSON.parse(storedPendingAuthorizationJson) as PendingOAuthAuthorization)
          : null,
      );
    }),
  };

  /** Plant a record directly, as if some other code path had stored it. */
  const plantPendingAuthorization = (
    pendingAuthorization: PendingOAuthAuthorization,
    pendingAuthorizationNonce: string,
  ) =>
    storedPendingAuthorizationJsonByKey.set(
      keyFor(pendingAuthorization.userId, pendingAuthorizationNonce),
      JSON.stringify(pendingAuthorization),
    );

  return {
    store,
    plantPendingAuthorization,
    storedPendingAuthorizationCount: () => storedPendingAuthorizationJsonByKey.size,
  };
}

function buildFakeOAuthProvider(serviceName: string, options: { usesPkce?: boolean } = {}) {
  const exchangeCodeForTokens = jest.fn<Promise<OAuthTokenResponse>, [string, ...unknown[]]>().mockResolvedValue({
    access_token: 'attacker-access-token',
    refresh_token: 'attacker-refresh-token',
    expires_in: 3600,
  });
  const generateAuthUrl = jest.fn(
    (state: string) => `https://provider.example/authorize?state=${encodeURIComponent(state)}`,
  );
  const provider: Partial<OAuthProvider> = {
    exchangeCodeForTokens: exchangeCodeForTokens as unknown as OAuthProvider['exchangeCodeForTokens'],
    generateAuthUrl: generateAuthUrl as unknown as OAuthProvider['generateAuthUrl'],
    getServiceName: () => serviceName,
    ...(options.usesPkce ? { usesPkce: () => true } : {}),
  };
  return { provider, exchangeCodeForTokens, generateAuthUrl };
}

function buildOAuthServiceUnderTest() {
  const fakeDb = buildFakeDbService();
  const pendingAuthorizationStore = buildInMemoryPendingAuthorizationStore();
  // Airtable's real provider uses PKCE, so its initiate stores a verifier.
  const airtable = buildFakeOAuthProvider('airtable', { usesPkce: true });
  const notion = buildFakeOAuthProvider('notion');
  const salesforce = buildFakeOAuthProvider('salesforce', { usesPkce: true });
  const identityCredentialEncryptionService = {
    encryptCredentials: (credentials: DecryptedCredentials) => Promise.resolve({ ...credentials }),
    decryptCredentials: (encrypted: unknown) => Promise.resolve({ ...(encrypted as DecryptedCredentials) }),
  };
  const credentialResolver = {
    getCurrentVersionForNewConnections: () => 2,
    resolveSystemAppCredentials: () => ({
      clientId: 'client-id',
      clientSecret: 'client-secret',
      redirectUri: 'https://redirect',
    }),
    resolveCustomAppCredentials: (clientId: string, clientSecret: string) => ({
      clientId,
      clientSecret,
      redirectUri: 'https://redirect',
    }),
  };

  // Positional, matching the constructor: db, the fourteen providers (AIRTABLE first, NOTION
  // fourth, SALESFORCE thirteenth, STRIPE last), then posthog, credential encryption, scratch-git,
  // config, credential resolver and the pending-authorization store.
  const providerPlaceholders: unknown[] = Array.from({ length: 14 }, () => ({}));
  providerPlaceholders[0] = airtable.provider;
  providerPlaceholders[3] = notion.provider;
  providerPlaceholders[12] = salesforce.provider;
  const constructorArguments = [
    fakeDb.db,
    ...providerPlaceholders,
    { captureEvent: jest.fn() },
    identityCredentialEncryptionService,
    { initRepo: jest.fn().mockResolvedValue(undefined) },
    { isProductionEnvironment: () => false },
    credentialResolver,
    pendingAuthorizationStore.store as unknown as OAuthPendingAuthorizationStore,
  ] as unknown as ConstructorParameters<typeof OAuthService>;

  return {
    oauthService: new OAuthService(...constructorArguments),
    salesforce,
    fakeDb,
    pendingAuthorizationStore,
    airtableExchangeCodeForTokens: airtable.exchangeCodeForTokens,
  };
}

function buildActor(overrides: Partial<Actor> = {}): Actor {
  return {
    userId: ATTACKER_USER_ID,
    organizationId: ATTACKER_ORGANIZATION_ID,
    subscriptionStatus: { status: 'active', planType: ScratchPlanType.FREE_PLAN },
    workspacePermissions: [
      { id: 'wsp_1' as WorkspacePermissionId, workbookId: ATTACKER_WORKBOOK_ID as WorkbookId, role: 'editor' },
      { id: 'wsp_2' as WorkspacePermissionId, workbookId: ATTACKER_SECOND_WORKBOOK_ID as WorkbookId, role: 'editor' },
    ],
    ...overrides,
  };
}

function buildInitiateOptions(
  overrides: Partial<ValidatedOAuthInitiateOptionsDto> = {},
): ValidatedOAuthInitiateOptionsDto {
  return {
    workbookId: ATTACKER_WORKBOOK_ID,
    resultForwardUrl: 'https://test.scratch.md/oauth/callback-step-2',
    connectionMethod: 'OAUTH_SYSTEM',
    returnPage: '/workspace/wkb_attacker',
    ...overrides,
  };
}

/** The `state` query param of an authorize URL produced by `initiateOAuth`. */
function extractStateFromAuthUrl(authUrl: string): string {
  const state = new URL(authUrl).searchParams.get('state');
  if (!state) {
    throw new Error(`authorize URL has no state: ${authUrl}`);
  }
  return state;
}

/** Decode exactly as dusky / the web callback pages / desktop do: `JSON.parse(atob(state))`. */
function decodeStateLikeTheFrontends(state: string): Record<string, unknown> {
  return JSON.parse(atob(state)) as Record<string, unknown>;
}

function encodeStateLikeTheServer(statePayload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(statePayload)).toString('base64');
}

/** A server-side record as initiate would have written it, for planting directly in the store. */
function buildPendingAuthorization(overrides: Partial<PendingOAuthAuthorization> = {}): PendingOAuthAuthorization {
  const workbookId = overrides.workbookId ?? ATTACKER_WORKBOOK_ID;
  const service = overrides.service ?? 'AIRTABLE';
  return {
    userId: ATTACKER_USER_ID,
    organizationId: ATTACKER_ORGANIZATION_ID,
    workbookId,
    service,
    connectionMethod: 'OAUTH_SYSTEM',
    oauthAppVersion: 2,
    publicRoutingFieldsAsMinted: { service, workbookId },
    ...overrides,
  };
}

function encodePublicStateFor(
  pendingAuthorization: PendingOAuthAuthorization,
  pendingAuthorizationNonce: string,
): string {
  const publicStatePayload: OAuthStatePayload = {
    ...pendingAuthorization.publicRoutingFieldsAsMinted,
    pendingAuthorizationNonce,
  };
  return encodeStateLikeTheServer(publicStatePayload);
}

describe('OAuthService — re-auth is bound to the caller’s connection (DEV-12155)', () => {
  beforeEach(() => {
    // Creating a connection checks the plan's data-source limit, which reads APP_ENV. CI doesn't
    // set it (locally it leaks in from server/.env), so pin it here.
    jest.spyOn(ScratchConfigService, 'getScratchEnvironment').mockReturnValue('test');
  });
  afterEach(() => jest.restoreAllMocks());

  describe('initiateOAuth', () => {
    it('puts only the routing fields and an opaque nonce in a state the frontends can still decode', async () => {
      const { oauthService, pendingAuthorizationStore } = buildOAuthServiceUnderTest();

      const { authUrl } = await oauthService.initiateOAuth(
        'AIRTABLE',
        buildActor(),
        buildInitiateOptions({
          connectionMethod: 'OAUTH_CUSTOM',
          customClientId: 'byo-id',
          customClientSecret: 'byo-secret',
        }),
      );

      const decodedState = decodeStateLikeTheFrontends(extractStateFromAuthUrl(authUrl));
      expect(Object.keys(decodedState).sort()).toEqual(
        ['pendingAuthorizationNonce', 'resultForwardUrl', 'returnPage', 'service', 'workbookId'].sort(),
      );
      expect(decodedState).toMatchObject({
        service: 'AIRTABLE',
        workbookId: ATTACKER_WORKBOOK_ID,
        resultForwardUrl: 'https://test.scratch.md/oauth/callback-step-2',
        returnPage: '/workspace/wkb_attacker',
      });
      // The PKCE verifier and the BYO client secret stay server-side.
      const [storedPendingAuthorization] =
        pendingAuthorizationStore.store.savePendingAuthorizationAndReturnNonce.mock.calls[0];
      expect(storedPendingAuthorization.codeVerifier).toEqual(expect.any(String));
      expect(storedPendingAuthorization.customClientSecret).toBe('byo-secret');
      expect(JSON.stringify(decodedState)).not.toContain(storedPendingAuthorization.codeVerifier);
      expect(JSON.stringify(decodedState)).not.toContain('byo-secret');
    });

    it.each([
      ['another org’s connection', 'coa_victim_other_org'],
      ['a connection in another of the caller’s workbooks', 'coa_attacker_second_workbook'],
      ['a connection of another service', 'coa_notion_same_workbook'],
      ['a non-OAuth connection', 'coa_api_key_same_workbook'],
      ['an unknown connection id', 'coa_does_not_exist'],
    ])('refuses to start a re-auth of %s, storing nothing', async (_description, connectorAccountId) => {
      const { oauthService, pendingAuthorizationStore } = buildOAuthServiceUnderTest();

      await expect(
        oauthService.initiateOAuth('AIRTABLE', buildActor(), buildInitiateOptions({ connectorAccountId })),
      ).rejects.toThrow(BadRequestException);
      expect(pendingAuthorizationStore.store.savePendingAuthorizationAndReturnNonce).not.toHaveBeenCalled();
    });

    it('refuses to start a connect in a workbook the caller cannot edit', async () => {
      const { oauthService, pendingAuthorizationStore } = buildOAuthServiceUnderTest();

      await expect(
        oauthService.initiateOAuth('AIRTABLE', buildActor(), buildInitiateOptions({ workbookId: VICTIM_WORKBOOK_ID })),
      ).rejects.toThrow(ForbiddenException);
      expect(pendingAuthorizationStore.store.savePendingAuthorizationAndReturnNonce).not.toHaveBeenCalled();
    });
  });

  describe('handleOAuthCallback', () => {
    it('reconnects a Salesforce sandbox connection at the sandbox host without being told again', async () => {
      const { oauthService, salesforce, fakeDb, pendingAuthorizationStore } = buildOAuthServiceUnderTest();
      const actor = buildActor();

      // The reconnect form doesn't offer the sandbox box, so the request doesn't carry it.
      const { authUrl } = await oauthService.initiateOAuth(
        'SALESFORCE',
        actor,
        buildInitiateOptions({ connectorAccountId: 'coa_salesforce_sandbox' }),
      );
      expect((salesforce.generateAuthUrl.mock.calls[0] as unknown[])[2]).toMatchObject({ sandbox: true });
      const [storedPendingAuthorization] =
        pendingAuthorizationStore.store.savePendingAuthorizationAndReturnNonce.mock.calls[0];
      expect(storedPendingAuthorization.salesforceSandbox).toBe(true);

      await oauthService.handleOAuthCallback('SALESFORCE', actor, {
        code: 'auth-code',
        state: extractStateFromAuthUrl(authUrl),
      });

      expect((salesforce.exchangeCodeForTokens.mock.calls[0] as unknown[])[2]).toMatchObject({ sandbox: true });
      expect(fakeDb.connectorAccountUpdates).toEqual([
        expect.objectContaining({
          id: 'coa_salesforce_sandbox',
          data: expect.objectContaining({ extras: { sandbox: true } }) as unknown,
        }),
      ]);
    });

    it('re-authorizes the caller’s own connection, under the connection credentials lock', async () => {
      const { oauthService, fakeDb } = buildOAuthServiceUnderTest();
      const actor = buildActor();
      const { authUrl } = await oauthService.initiateOAuth(
        'AIRTABLE',
        actor,
        buildInitiateOptions({ connectorAccountId: 'coa_attacker_own' }),
      );

      const result = await oauthService.handleOAuthCallback('AIRTABLE', actor, {
        code: 'auth-code',
        state: extractStateFromAuthUrl(authUrl),
      });

      expect(result).toEqual({ connectorAccountId: 'coa_attacker_own' });
      expect(fakeDb.findConnectorAccountRow('coa_attacker_own')?.encryptedCredentials).toMatchObject({
        oauthAccessToken: 'attacker-access-token',
      });
      expect(fakeDb.connectorAccountUpdates).toEqual([
        expect.objectContaining({ id: 'coa_attacker_own', insideTransaction: true }),
      ]);
      expect(fakeDb.advisoryLockQueries).toHaveLength(1);
      expect(fakeDb.advisoryLockQueries[0]).toContain('pg_try_advisory_xact_lock');
      expect(fakeDb.advisoryLockQueries[0]).toContain('oauth-token-refresh:coa_attacker_own');
    });

    it('creates a new connection when the connect is not a re-auth', async () => {
      const { oauthService, fakeDb } = buildOAuthServiceUnderTest();
      const actor = buildActor();
      const { authUrl } = await oauthService.initiateOAuth('AIRTABLE', actor, buildInitiateOptions());

      await oauthService.handleOAuthCallback('AIRTABLE', actor, {
        code: 'auth-code',
        state: extractStateFromAuthUrl(authUrl),
      });

      expect(fakeDb.connectorAccountCreates).toEqual([
        expect.objectContaining({ workbookId: ATTACKER_WORKBOOK_ID, service: 'AIRTABLE' }),
      ]);
      expect(fakeDb.connectorAccountUpdates).toHaveLength(0);
    });

    /**
     * Initiate refuses these ids, so a record naming one can only come from some other path;
     * the callback must still refuse to write through it.
     */
    it.each([
      ['another org’s connection', 'coa_victim_other_org'],
      ['a connection in another of the caller’s workbooks', 'coa_attacker_second_workbook'],
      ['a connection of another service', 'coa_notion_same_workbook'],
      ['a non-OAuth connection', 'coa_api_key_same_workbook'],
    ])(
      'rejects a record naming %s without exchanging the code or writing',
      async (_description, connectorAccountId) => {
        const { oauthService, fakeDb, pendingAuthorizationStore, airtableExchangeCodeForTokens } =
          buildOAuthServiceUnderTest();
        const credentialsBefore = structuredClone(
          fakeDb.findConnectorAccountRow(connectorAccountId)?.encryptedCredentials,
        );
        const pendingAuthorization = buildPendingAuthorization({ connectorAccountId });
        pendingAuthorizationStore.plantPendingAuthorization(pendingAuthorization, 'planted-nonce');

        await expect(
          oauthService.handleOAuthCallback('AIRTABLE', buildActor(), {
            code: 'attacker-code',
            state: encodePublicStateFor(pendingAuthorization, 'planted-nonce'),
          }),
        ).rejects.toThrow(BadRequestException);

        expect(airtableExchangeCodeForTokens).not.toHaveBeenCalled();
        expect(fakeDb.connectorAccountUpdates).toHaveLength(0);
        expect(fakeDb.connectorAccountCreates).toHaveLength(0);
        expect(fakeDb.findConnectorAccountRow(connectorAccountId)?.encryptedCredentials).toEqual(credentialsBefore);
      },
    );

    it('rejects a state edited to name the victim’s connection, leaving the victim untouched', async () => {
      // The original attack: start a normal connect in your own workbook, then add the
      // victim's connection id (and workbook) to the decoded state before calling back.
      const { oauthService, fakeDb, airtableExchangeCodeForTokens } = buildOAuthServiceUnderTest();
      const actor = buildActor();
      const { authUrl } = await oauthService.initiateOAuth('AIRTABLE', actor, buildInitiateOptions());
      const tamperedState = encodeStateLikeTheServer({
        ...decodeStateLikeTheFrontends(extractStateFromAuthUrl(authUrl)),
        connectorAccountId: 'coa_victim_other_org',
        workbookId: VICTIM_WORKBOOK_ID,
      });

      await expect(
        oauthService.handleOAuthCallback('AIRTABLE', actor, { code: 'attacker-code', state: tamperedState }),
      ).rejects.toThrow(BadRequestException);

      expect(airtableExchangeCodeForTokens).not.toHaveBeenCalled();
      expect(fakeDb.connectorAccountUpdates).toHaveLength(0);
      expect(fakeDb.connectorAccountCreates).toHaveLength(0);
      expect(fakeDb.findConnectorAccountRow('coa_victim_other_org')?.encryptedCredentials).toEqual(VICTIM_CREDENTIALS);
    });

    it('rejects a state whose routing fields were edited, even with a valid nonce', async () => {
      const { oauthService, fakeDb } = buildOAuthServiceUnderTest();
      const actor = buildActor();
      const { authUrl } = await oauthService.initiateOAuth('AIRTABLE', actor, buildInitiateOptions());
      const editedState = encodeStateLikeTheServer({
        ...decodeStateLikeTheFrontends(extractStateFromAuthUrl(authUrl)),
        returnPage: '/somewhere-else',
      });

      await expect(
        oauthService.handleOAuthCallback('AIRTABLE', actor, { code: 'c', state: editedState }),
      ).rejects.toThrow(BadRequestException);
      expect(fakeDb.connectorAccountCreates).toHaveLength(0);
    });

    it('rejects a callback for a different service than the connect was started for', async () => {
      const { oauthService, fakeDb } = buildOAuthServiceUnderTest();
      const actor = buildActor();
      const { authUrl } = await oauthService.initiateOAuth(
        'AIRTABLE',
        actor,
        buildInitiateOptions({ connectorAccountId: 'coa_attacker_own' }),
      );

      await expect(
        oauthService.handleOAuthCallback('NOTION', actor, { code: 'c', state: extractStateFromAuthUrl(authUrl) }),
      ).rejects.toThrow(BadRequestException);
      expect(fakeDb.connectorAccountUpdates).toHaveLength(0);
      expect(fakeDb.findConnectorAccountRow('coa_attacker_own')?.encryptedCredentials).toEqual({
        oauthAccessToken: 'old-own-access-token',
      });
    });

    it('accepts a state only once', async () => {
      const { oauthService, fakeDb } = buildOAuthServiceUnderTest();
      const actor = buildActor();
      const { authUrl } = await oauthService.initiateOAuth('AIRTABLE', actor, buildInitiateOptions());
      const state = extractStateFromAuthUrl(authUrl);

      await oauthService.handleOAuthCallback('AIRTABLE', actor, { code: 'c', state });
      await expect(oauthService.handleOAuthCallback('AIRTABLE', actor, { code: 'c', state })).rejects.toThrow(
        /expired or was already used/,
      );
      expect(fakeDb.connectorAccountCreates).toHaveLength(1);
    });

    it('does not let another user redeem (or burn) someone else’s state', async () => {
      const { oauthService, fakeDb, pendingAuthorizationStore } = buildOAuthServiceUnderTest();
      const { authUrl } = await oauthService.initiateOAuth('AIRTABLE', buildActor(), buildInitiateOptions());
      const state = extractStateFromAuthUrl(authUrl);

      await expect(
        oauthService.handleOAuthCallback('AIRTABLE', buildActor({ userId: 'usr_someone_else' }), { code: 'c', state }),
      ).rejects.toThrow(/expired or was already used/);
      expect(fakeDb.connectorAccountCreates).toHaveLength(0);
      expect(pendingAuthorizationStore.storedPendingAuthorizationCount()).toBe(1);
    });

    it.each([
      [
        'a forged nonce',
        encodeStateLikeTheServer({
          service: 'AIRTABLE',
          workbookId: ATTACKER_WORKBOOK_ID,
          pendingAuthorizationNonce: 'forged',
        }),
      ],
      [
        'a pre-DEV-12155 state carrying its own connection id',
        encodeStateLikeTheServer({
          userId: ATTACKER_USER_ID,
          organizationId: ATTACKER_ORGANIZATION_ID,
          workbookId: ATTACKER_WORKBOOK_ID,
          service: 'AIRTABLE',
          connectionMethod: 'OAUTH_SYSTEM',
          connectorAccountId: 'coa_victim_other_org',
          ts: Date.now(),
        }),
      ],
      ['a state that is not base64 JSON', 'not-a-state'],
    ])('rejects %s without exchanging the code or writing', async (_description, state) => {
      const { oauthService, fakeDb, airtableExchangeCodeForTokens } = buildOAuthServiceUnderTest();

      await expect(oauthService.handleOAuthCallback('AIRTABLE', buildActor(), { code: 'c', state })).rejects.toThrow(
        BadRequestException,
      );
      expect(airtableExchangeCodeForTokens).not.toHaveBeenCalled();
      expect(fakeDb.connectorAccountUpdates).toHaveLength(0);
      expect(fakeDb.connectorAccountCreates).toHaveLength(0);
      expect(fakeDb.findConnectorAccountRow('coa_victim_other_org')?.encryptedCredentials).toEqual(VICTIM_CREDENTIALS);
    });
  });
});
