import { ConnectorAccount as PrismaConnectorAccount } from '@prisma/client';
import { DecryptedCredentials } from '../types/encrypted-credentials.interface';

export type ConnectorAccount = Pick<
  PrismaConnectorAccount,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'userId'
  | 'workbookId'
  | 'service'
  | 'displayName'
  | 'authType'
  | 'encryptedCredentials'
  | 'healthStatus'
  | 'healthStatusLastCheckedAt'
  | 'healthStatusMessage'
  | 'modifier'
  | 'extras'
  | 'version'
>;

export type ConnectorAccountWithCredentials = ConnectorAccount & DecryptedCredentials;
