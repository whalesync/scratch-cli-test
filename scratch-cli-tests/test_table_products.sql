CREATE TABLE integration_products (
    product_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    price         NUMERIC(10,2) NOT NULL DEFAULT 0,
    category      TEXT NOT NULL DEFAULT 'uncategorized',
    created_dt    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_dt    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
