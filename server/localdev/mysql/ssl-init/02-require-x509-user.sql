-- Only for the opt-in `mysql-ssl` service in server/localdev/docker-compose.mysql.yml (runs after 01-companies-and-deals.sql
-- on a first start with an empty volume). `x509_user` may only log in while presenting a client certificate. The MySQL
-- connector deliberately has no client-certificate (mTLS) option in v1, so connecting as this user must fail with the
-- 1045 access-denied message under every SSL Mode — that failure is what this account exists to show.

CREATE USER 'x509_user'@'%' IDENTIFIED BY 'test' REQUIRE X509;
GRANT ALL PRIVILEGES ON test_db.* TO 'x509_user'@'%';
