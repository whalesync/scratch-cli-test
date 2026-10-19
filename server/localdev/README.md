To run the Postgres, Redis, MongoDB locally, simply run the following from within this localdev folder:

```sh
docker compose up -d
```

## MySQL / MariaDB (opt-in, for the MySQL connector)

Not started by the default `docker compose up -d`. From this folder:

```sh
docker compose -f docker-compose.mysql.yml up -d --wait   # returns once both servers accept logins
docker compose -f docker-compose.mysql.yml down           # stop, keep data
docker compose -f docker-compose.mysql.yml down -v        # stop and wipe (the next `up` re-seeds from ./mysql/init)
```

- MySQL 8.4: `mysql://test:test@127.0.0.1:3306/test_db` (root password `root`)
- MariaDB 11.4: `mysql://test:test@127.0.0.1:3307/test_db` (root password `root`)

Both servers are seeded with `companies` and `deals` (`./mysql/init/01-companies-and-deals.sql`) for manual testing.
The MySQL connector integration specs (`server/test/integration/mysql-*.spec.ts`) create their own tables; point
them at these servers with the `MYSQL_*` / `MARIADB_*` variables in `server/.env.integration` (see
`.env.integration.example`). If you also run another MySQL on 127.0.0.1:3306, stop it first.

### MySQL with custom TLS certificates (opt-in, for the connector's SSL settings)

The servers above use auto-generated certificates that name no host, so `VERIFY_IDENTITY` can only fail against
them, and they accept plaintext. The `mysql-ssl` service (compose profile `ssl`, MySQL 8.4 on 127.0.0.1:3308) uses a
throwaway test CA whose server certificate names `localhost`, and refuses unencrypted logins
(`require_secure_transport=ON`). From this folder:

```sh
./mysql/generate-ssl-certs.sh                                        # once; --force regenerates
docker compose -f docker-compose.mysql.yml --profile ssl up -d --wait mysql-ssl
docker compose -f docker-compose.mysql.yml --profile ssl down        # plain `down` leaves mysql-ssl running
```

- URL: `mysql://test:test@localhost:3308/test_db` (root password `root`), seeded with the same `companies` / `deals`.
- CA Certificate to paste: `./mysql/ssl-certs/ca.pem` (gitignored). `./mysql/ssl-certs/wrong-ca.pem` is an
  unrelated CA for the negative case.
- Use Host `localhost` for `VERIFY_IDENTITY`: the connector refuses an IP host with that mode.
- SSL Mode `DISABLED` fails with the "only accepts encrypted connections" message (errno 3159).
- `x509_user` / `test` requires a client certificate (`REQUIRE X509`). The connector has no mTLS option, so it
  always gets access denied (1045).
- After `--force`, recreate the container so mysqld loads the new files: add `--force-recreate` to the `up` command.
