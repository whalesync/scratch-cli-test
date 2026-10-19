// knex's built-in mysql2 dialect client class. knex ships no typings for this deep path; it is the class knex
// itself instantiates for `client: 'mysql2'`. The MySQL connector subclasses it to hand knex the mysql2 driver
// resolved from the server package (see library/mysql/mysql-knex-dialect-client.ts).
declare module 'knex/lib/dialects/mysql2' {
  import { type Knex } from 'knex';
  const KnexMySql2DialectClient: typeof Knex.Client;
  export default KnexMySql2DialectClient;
}
