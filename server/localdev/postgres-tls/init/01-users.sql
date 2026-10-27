-- Only for the opt-in `postgres-tls` service in server/localdev/docker-compose.postgres-tls.yml (runs on a first start
-- with an empty volume). Both users log in with a password over TLS; `scratch_tls_cert_user` must also present a
-- client certificate (see ../pg_hba.conf).
CREATE USER scratch_tls_password_user WITH PASSWORD 'scratch-tls-test';
CREATE USER scratch_tls_cert_user WITH PASSWORD 'scratch-tls-test';
GRANT ALL PRIVILEGES ON DATABASE scratch_tls_test TO scratch_tls_password_user, scratch_tls_cert_user;
GRANT ALL ON SCHEMA public TO scratch_tls_password_user, scratch_tls_cert_user;
