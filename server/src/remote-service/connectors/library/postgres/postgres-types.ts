/**
 * Types for the PostgreSQL connector.
 */
import { type PostgresTlsCertificates } from '../pg-common';

/** What a Postgres connection stores: the connection string and, optionally, its TLS certificates (canonical PEM). */
export interface PostgresCredentials extends PostgresTlsCertificates {
  connectionString: string;
}
