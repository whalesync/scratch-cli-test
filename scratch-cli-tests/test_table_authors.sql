CREATE TABLE integration_authors (
    author_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(20) NOT NULL,
    bio         TEXT,
    created_dt  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_dt  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);