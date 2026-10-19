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
