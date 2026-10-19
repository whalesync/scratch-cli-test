/**
 * Which MySQL-protocol server we're talking to. Detected once per physical connection from `SELECT VERSION()`
 * (not the handshake: proxies such as ProxySQL, MaxScale, RDS Proxy and vtgate put their own version in the
 * greeting, and MariaDB < 11.0.1 prefixes it with `5.5.5-`).
 *
 * TiDB and Vitess/PlanetScale speak the MySQL dialect; they only matter where a server rejects a MySQL-specific
 * session variable, which the session setup already tolerates.
 */
export type MySqlServerFlavor = 'mysql' | 'mariadb' | 'tidb' | 'vitess';

export function classifyMySqlServerFlavor(serverVersion: string): MySqlServerFlavor {
  if (/mariadb/i.test(serverVersion)) return 'mariadb';
  if (/tidb/i.test(serverVersion)) return 'tidb';
  if (/vitess|planetscale/i.test(serverVersion)) return 'vitess';
  return 'mysql';
}
