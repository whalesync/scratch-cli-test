/**
 * Shared enums between client and server.
 * These enums mirror the Prisma schema enums in server/prisma/schema.prisma
 *
 * IMPORTANT: When adding/modifying enums in the Prisma schema, update this file accordingly.
 */

export enum Service {
  NOTION = 'NOTION',
  AIRTABLE = 'AIRTABLE',
  POSTGRES = 'POSTGRES',
  YOUTUBE = 'YOUTUBE',
  WORDPRESS = 'WORDPRESS',
  WEBFLOW = 'WEBFLOW',
  WIX_BLOG = 'WIX_BLOG',
  AUDIENCEFUL = 'AUDIENCEFUL',
  MOCO = 'MOCO',
  SHOPIFY = 'SHOPIFY',
  SUPABASE = 'SUPABASE',
}

export enum AuthType {
  API_KEY = 'API_KEY',
  OAUTH = 'OAUTH',
  USER_PROVIDED_PARAMS = 'USER_PROVIDED_PARAMS',
}

export enum UserRole {
  USER = 'USER',
  ADMIN = 'ADMIN',
}

export enum TokenType {
  AGENT = 'AGENT',
  WEBSOCKET = 'WEBSOCKET',
  USER = 'USER',
}

export enum AiAgentCredentialSource {
  USER = 'USER',
  SYSTEM = 'SYSTEM',
}

export enum ConnectorHealthStatus {
  OK = 'OK',
  FAILED = 'FAILED',
}

export enum ActionType {
  PUBLISH = 'PUBLISH',
}

export enum SyncState {
  OFF = 'OFF',
  ON = 'ON',
}

export enum ScheduleAction {
  PULL = 'PULL',
  PUBLISH = 'PUBLISH',
  SYNC = 'SYNC',
}

export enum TableDiscoveryMode {
  LIST = 'LIST',
  SEARCH = 'SEARCH',
}
