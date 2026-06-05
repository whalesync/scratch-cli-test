import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LogLevel, WSLogger } from 'src/logger';
import { stringToEnum } from 'src/utils/helpers';

/** This should basically never be used. */
export type NodeEnvironment = 'development' | 'test' | 'staging' | 'production';

/** This should be used for checking the deployment flavor. */
export type ScratchEnvironment = 'development' | 'test' | 'staging' | 'production';

/**
 * The current type of this microservice. This same binary is used to run multiple kinds of microservices, and the
 * behavior of each microservice is different.
 */
export enum MicroserviceType {
  FRONTEND = 'api',
  // Just runs worker tasks for bull MQ
  WORKER = 'worker',
  // Runs cron tasks
  CRON = 'cron',
  // Generally used for local development. Combines *all* microservice types in one server.
  MONOLITH = 'monolith',
}

@Injectable()
export class ScratchConfigService {
  private readonly databaseUrl: string;
  private readonly environment: ScratchEnvironment;
  private readonly serviceTypes: MicroserviceType[];
  private readonly runningInCloudRun: boolean;

  constructor(private readonly configService: ConfigService) {
    this.databaseUrl = this.getEnvVariable('DATABASE_URL');
    this.runningInCloudRun = this.getOptionalFlagVariable('RUNNING_IN_CLOUD', false);
    this.environment = ScratchConfigService.getScratchEnvironment();
    this.serviceTypes = ScratchConfigService.getServiceTypes();

    if (process.env.LOG_LEVEL) {
      WSLogger.info({
        source: 'ScratchpadConfigService',
        message: 'Setting log level',
        logLevel: process.env.LOG_LEVEL,
      });
      WSLogger.setOutputLevel(stringToEnum(process.env.LOG_LEVEL, LogLevel, LogLevel.INFO));
    }
  }

  getScratchEnvironment(): ScratchEnvironment {
    return this.environment;
  }

  isProductionEnvironment(): boolean {
    return this.environment === 'production';
  }

  getServiceTypes(): MicroserviceType[] {
    return this.serviceTypes;
  }

  getDatabaseUrl(): string {
    return this.databaseUrl;
  }

  getClerkSecretKey(): string {
    return this.getEnvVariable('CLERK_SECRET_KEY');
  }

  getClerkPublishableKey(): string {
    return this.getEnvVariable('CLERK_PUBLISHABLE_KEY');
  }

  /**
   * Admin secrets accepted by ScratchAdminGuard for the internal Whalesync channel
   * (`/internal/whalesync/*`). Supports rotation: the current key plus an optional previous key
   * during a rotation window. Returns an empty array when unconfigured, in which case
   * ScratchAdminGuard denies all requests (fail closed).
   */
  getScratchAdminApiKeys(): string[] {
    return [
      this.getOptionalEnvVariable<string>('SCRATCH_ADMIN_API_KEY'),
      this.getOptionalEnvVariable<string>('SCRATCH_ADMIN_API_KEY_PREVIOUS'),
    ].filter((key): key is string => !!key);
  }

  getDbDebug(): boolean {
    return this.getOptionalFlagVariable('DB_DEBUG', false);
  }

  isPosthogAnaltyicsEnabled(): boolean {
    // default to true for deployed environments
    return this.getOptionalFlagVariable('POSTHOG_ANALYTICS_ENABLED', this.getScratchEnvironment() !== 'development');
  }

  getPostHogApiKey(): string | undefined {
    return this.getOptionalEnvVariable('POSTHOG_API_KEY');
  }

  getPostHogHost(): string | undefined {
    return this.getOptionalEnvVariable('POSTHOG_HOST');
  }

  getPosthogFeatureFlagApiKey(): string | undefined {
    return this.getOptionalEnvVariable('POSTHOG_FEATURE_FLAG_API_KEY');
  }

  getStripeApiKey(): string {
    return this.getEnvVariable('STRIPE_API_KEY');
  }

  getStripeWebhookSecret(): string {
    return this.getEnvVariable('STRIPE_WEBHOOK_SECRET');
  }

  getSlackNotificationWebhookUrl(): string | undefined {
    return this.getOptionalEnvVariable('SLACK_NOTIFICATION_WEBHOOK_URL');
  }

  isSlackNotificationEnabled(): boolean {
    return this.getOptionalFlagVariable('SLACK_NOTIFICATION_ENABLED', false);
  }

  getRedisHost(): string {
    return this.getOptionalEnvVariable<string>('REDIS_HOST') ?? 'localhost';
  }

  getRedisPort(): number {
    return this.getOptionalNumberVariable('REDIS_PORT', 6379);
  }

  getRedisPassword(): string | undefined {
    return this.getOptionalEnvVariable<string>('REDIS_PASSWORD');
  }

  getWorkerConcurrency(): number {
    return this.getOptionalNumberVariable('WORKER_CONCURRENCY', 2);
  }

  getWorkerLockTimeout(): number {
    return this.getOptionalNumberVariable('WORKER_LOCK_TIMEOUT_MS', 120_000);
  }

  getUseJobs(): boolean {
    return this.getOptionalFlagVariable('USE_JOBS', false);
  }

  /**
   * When true, API token requests bypass rate limiting as if every token had the `rate-limit:unlimited` scope.
   *
   * Defaults to true in development so the local server doesn't 429 on integration drivers,
   * dogfooding sessions, or rapid manual workflows. Test/staging/production default to false;
   * the env var still wins either way.
   */
  isApiRateLimitDisabled(): boolean {
    return this.getOptionalFlagVariable('API_RATE_LIMIT_DISABLED', this.getScratchEnvironment() === 'development');
  }

  getLinearApiKey(): string | undefined {
    return this.getOptionalEnvVariable('LINEAR_API_KEY');
  }

  getScratchApplicationUrl(): string {
    const env = ScratchConfigService.getScratchEnvironment();
    if (env === 'development') {
      return `http://localhost:3000`;
    }

    if (env === 'production') {
      return 'https://app.scratch.md';
    }
    return `https://${env}.scratch.md`;
  }

  getScratchServerUrl(): string {
    return this.getOptionalEnvVariable('MCP_SERVER_URL') ?? ScratchConfigService.getApiBaseUrl();
  }

  getMcpClientUrl(): string {
    return this.getOptionalEnvVariable('MCP_CLIENT_URL') ?? this.getScratchApplicationUrl();
  }

  getScratchGitApiUrl(): string {
    return this.getOptionalEnvVariable('SCRATCH_GIT_API_URL') ?? 'http://localhost:3100';
  }

  getSendGridApiKey(): string | undefined {
    return this.getOptionalEnvVariable('SENDGRID_API_KEY');
  }

  getSendGridFromEmail(): string {
    return this.getOptionalEnvVariable<string>('SENDGRID_FROM_EMAIL') ?? 'support@scratch.md';
  }

  getOpenRouterApiKeyOptional(): string | undefined {
    return this.getOptionalEnvVariable('OPENROUTER_API_KEY');
  }

  getWhalesyncApiUrl(): string {
    return (
      this.getOptionalEnvVariable('WHALESYNC_API_URL') ?? 'https://production-bottlenose-frontend-service.whalesync.com'
    );
  }

  getScratchGitBackendUrl(): string {
    return this.getOptionalEnvVariable('SCRATCH_GIT_BACKEND_URL') ?? 'http://localhost:3101';
  }

  getGcsAssetBucket(): string | undefined {
    return this.getOptionalEnvVariable('GCS_ASSET_BUCKET');
  }

  /**
   * Bucket for short-lived publish-patch payloads uploaded via `/upload-patch`.
   * Intentionally separate from the asset bucket: patches contain user record
   * data and must NOT live in the publicly-readable asset bucket. Deliberately
   * has no fallback — when unset, `/upload-patch/init` returns 503.
   */
  getGcsPatchUploadBucket(): string | undefined {
    return this.getOptionalEnvVariable('GCS_PATCH_UPLOAD_BUCKET');
  }

  getGcsProjectId(): string | undefined {
    return this.getOptionalEnvVariable('GCS_PROJECT_ID');
  }

  /**
   * Local-dev escape hatch: when set, the server impersonates the named
   * service account when generating V4 signed URLs. Needed because user-mode
   * ADC (`gcloud auth application-default login`) has no `client_email`, which
   * the Storage SDK's default signer requires. In Cloud Run, ADC IS the
   * runtime service account, so signing works natively and this stays unset.
   *
   * The caller must have `roles/iam.serviceAccountTokenCreator` on the target.
   */
  getGcsLocalSigningServiceAccount(): string | undefined {
    return this.getOptionalEnvVariable('GCS_LOCAL_SIGNING_SA');
  }

  /**
   * Override the @google-cloud/storage SDK's `apiEndpoint`. Used by the smoke
   * stack to point the server at a `fake-gcs-server` running on a sibling
   * container. Unlike `STORAGE_EMULATOR_HOST` (which the SDK reads natively
   * but strips `/storage/v1` from in the baseUrl), passing the value as a
   * constructor option keeps the JSON API at `/storage/v1/b/<bucket>/o/<obj>`
   * for reads while V4-signed URLs still point at the bare `<host>/<bucket>/<obj>`
   * — both shapes fake-gcs-server natively serves. Unset in prod; ADC + real
   * GCS take the default `https://storage.googleapis.com`.
   */
  getGcsApiEndpoint(): string | undefined {
    return this.getOptionalEnvVariable('GCS_API_ENDPOINT');
  }

  getUseOpenTelemetryMetrics(): boolean {
    return this.getOptionalFlagVariable('USE_OPENTELEMETRY_METRICS', false);
  }

  getRunningInCloud(): boolean {
    return this.runningInCloudRun;
  }

  getFriendlyServiceName(): string {
    return `scratch-${this.serviceTypes.join('-')}`;
  }

  getBuildVersion(): string {
    return this.getOptionalEnvVariable<string>('BUILD_VERSION') ?? 'local';
  }

  private getEnvVariable<T>(envVariable: string): T {
    const returnedVar: T | undefined = this.configService.get<T>(envVariable);
    if (returnedVar === undefined) {
      throw new Error(`${envVariable} is not defined. Please add this variable to your environment.`);
    }
    return returnedVar;
  }

  private getOptionalEnvVariable<T>(envVariable: string): T | undefined {
    const returnedVar: T | undefined = this.configService.get<T>(envVariable);
    return returnedVar ?? undefined;
  }

  private getOptionalNumberVariable(envVariable: string, defaultValue: number): number {
    const returnedVar: string | undefined = this.configService.get<string>(envVariable);
    if (returnedVar === undefined) {
      return defaultValue;
    }
    return parseFloat(returnedVar);
  }

  private getOptionalFlagVariable(envVariable: string, defaultValue: boolean): boolean {
    const returnedVar: string | undefined = this.configService.get<string>(envVariable);
    if (returnedVar === undefined) {
      return defaultValue;
    }
    return returnedVar.toLowerCase() === 'true';
  }

  /*
   * STATIC METHODS
   */

  public static getScratchEnvironment(): ScratchEnvironment {
    return checkIsString(process.env.APP_ENV, 'APP_ENV', [
      'development',
      'test',
      'staging',
      'production',
      'automated_test',
    ]) as ScratchEnvironment;
  }

  public static isRunningInCloudRun(): boolean {
    return process.env.RUNNING_IN_CLOUD === 'true';
  }

  public static getClientBaseUrl(): string {
    const env = ScratchConfigService.getScratchEnvironment();
    if (env === 'development') {
      return `http://localhost:3000`;
    }

    if (env === 'production') {
      // Need to check this because we have two different production environments until we fully migrate to the new domain.
      return ScratchConfigService.isRunningInCloudRun() ? 'https://app.scratch.md' : 'https://app.scratchpaper.ai';
    }

    // Otherwise, test or staging
    return `https://${env}.scratch.md`;
  }

  /**
   * Origins for the Whalesync product (Dusky) that call the Scratch API directly from the browser as a
   * shadow user. Sourced from the `WHALESYNC_APP_ORIGINS` env var (comma-separated) so test/staging/dev
   * origins are configurable without a code change; in production it falls back to `app.whalesync.com`.
   */
  public static getWhalesyncAppOrigins(): string[] {
    const configured = process.env.WHALESYNC_APP_ORIGINS;
    if (configured) {
      return configured
        .split(',')
        .map((origin) => origin.trim())
        .filter((origin) => origin.length > 0);
    }
    return ScratchConfigService.getScratchEnvironment() === 'production' ? ['https://app.whalesync.com'] : [];
  }

  /**
   * Returns a CORS origin callback that allows:
   * - The web client origin (e.g. http://localhost:3000 in dev, https://app.scratch.md in prod)
   * - The Electron desktop app dev server (http://localhost:5173) in development
   * - The Whalesync product (Dusky) origins, which call the Scratch API directly as shadow users
   * - Requests with no Origin header (null) — this covers packaged Electron apps that load from file://
   */
  public static getCorsAllowedOrigins(): (
    origin: string | undefined,
    callback: (err: Error | null, allow?: boolean) => void,
  ) => void {
    const env = ScratchConfigService.getScratchEnvironment();
    const allowedOrigins = new Set<string>([ScratchConfigService.getClientBaseUrl()]);
    if (env === 'development') {
      allowedOrigins.add('http://localhost:5173');
    }
    for (const whalesyncOrigin of ScratchConfigService.getWhalesyncAppOrigins()) {
      allowedOrigins.add(whalesyncOrigin);
    }

    return (origin, callback) => {
      // Allow requests with no Origin (e.g. packaged Electron apps loading from file://, server-to-server, curl)
      if (!origin || allowedOrigins.has(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    };
  }

  public static getApiBaseUrl(): string {
    const env = ScratchConfigService.getScratchEnvironment();
    if (env === 'development') {
      const port = process.env.PORT ?? '3010';
      return `http://localhost:${port}`;
    }

    if (env === 'production') {
      return 'https://api.scratch.md';
    }

    // Otherwise, test or staging
    return `https://${env}-api.scratch.md`;
  }

  public static getServiceTypes(): MicroserviceType[] {
    const raw = process.env.SERVICE_TYPE;
    if (!raw || raw.length === 0) {
      throw new Error('env var SERVICE_TYPE must be set, but was empty');
    }

    const validTypes = Object.values(MicroserviceType);
    const types = raw.split(',').map((s) => s.trim()) as MicroserviceType[];

    for (const type of types) {
      if (!validTypes.includes(type)) {
        throw new Error(
          `env var SERVICE_TYPE contains invalid value '${type}'. Must be one of: ${validTypes.join(', ')}`,
        );
      }
    }

    if (types.includes(MicroserviceType.MONOLITH) && types.length > 1) {
      throw new Error(
        `env var SERVICE_TYPE contains 'monolith' combined with other types (${raw}). 'monolith' must be used alone`,
      );
    }

    return [...new Set(types)];
  }

  public static isAPIService(): boolean {
    const types = ScratchConfigService.getServiceTypes();
    return types.includes(MicroserviceType.FRONTEND) || types.includes(MicroserviceType.MONOLITH);
  }

  public static isTaskWorkerService(): boolean {
    const types = ScratchConfigService.getServiceTypes();
    return types.includes(MicroserviceType.WORKER) || types.includes(MicroserviceType.MONOLITH);
  }

  public static isCronService(): boolean {
    const types = ScratchConfigService.getServiceTypes();
    return types.includes(MicroserviceType.CRON) || types.includes(MicroserviceType.MONOLITH);
  }

  public static isMonolithService(): boolean {
    const types = ScratchConfigService.getServiceTypes();
    return types.includes(MicroserviceType.MONOLITH);
  }
}

/*
 * UTILITY FUNCTIONS
 */

function checkIsString(value: string | undefined, varName: string, restrictToOptions?: string[]): string {
  if (value === undefined || value.length === 0) {
    throw new Error(`env var ${varName} must be set, but was empty`);
  }
  if (restrictToOptions !== undefined && !restrictToOptions.includes(value)) {
    throw new Error(`env var ${varName} must be one of: ${restrictToOptions.join(', ')}, but it was ${value}`);
  }
  return value;
}
