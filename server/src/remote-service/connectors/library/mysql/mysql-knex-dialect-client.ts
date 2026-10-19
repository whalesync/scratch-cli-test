/**
 * knex's mysql2 dialect, with the driver injected instead of `require`d by knex.
 *
 * knex's stock dialect calls `require('mysql2')` from knex's own location (the monorepo root `node_modules`).
 * Yarn can't hoist mysql2 there — it needs iconv-lite ^0.7 while the root resolves 0.6 — so mysql2 lives in
 * `server/node_modules` and the stock `client: 'mysql2'` would fail with "run npm install mysql2". Handing the
 * driver over explicitly makes the connector independent of hoisting and guarantees it runs the mysql2 version
 * pinned in server/package.json (the version the security review covered).
 */
import KnexMySql2DialectClient from 'knex/lib/dialects/mysql2';
import mysql2 from 'mysql2';

export class ScratchMySql2KnexDialectClient extends KnexMySql2DialectClient {
  _driver(): typeof mysql2 {
    return mysql2;
  }
}
