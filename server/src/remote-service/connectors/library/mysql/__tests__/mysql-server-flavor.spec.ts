import { classifyMySqlServerFlavor, type MySqlServerFlavor } from '../mysql-server-flavor';

describe('classifyMySqlServerFlavor', () => {
  it.each<[string, MySqlServerFlavor]>([
    ['8.4.11', 'mysql'],
    ['8.0.36', 'mysql'],
    ['8.0.mysql_aurora.3.05.2', 'mysql'],
    ['8.0.35-google', 'mysql'],
    ['11.4.13-MariaDB-ubu2404', 'mariadb'],
    ['10.11.6-MariaDB-log', 'mariadb'],
    ['5.5.5-10.6.12-MariaDB', 'mariadb'],
    ['8.0.11-TiDB-v7.5.0', 'tidb'],
    ['5.7.25-TiDB-v6.5.0-serverless', 'tidb'],
    ['8.0.30-Vitess', 'vitess'],
    ['8.0.34-PlanetScale', 'vitess'],
    ['', 'mysql'],
  ])('%j → %s', (serverVersion, expectedServerFlavor) => {
    expect(classifyMySqlServerFlavor(serverVersion)).toBe(expectedServerFlavor);
  });
});
