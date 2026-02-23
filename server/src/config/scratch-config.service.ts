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

  getUseJobs(): boolean {
    return this.getOptionalFlagVariable('USE_JOBS', false);
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

  getScratchGitApiUrl(): string {
    return this.getOptionalEnvVariable('SCRATCH_GIT_API_URL') ?? 'http://localhost:3100';
  }

  getScratchGitBackendUrl(): string {
    return this.getOptionalEnvVariable('SCRATCH_GIT_BACKEND_URL') ?? 'http://localhost:3101';
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
