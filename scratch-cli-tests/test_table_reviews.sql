CREATE TABLE integration_reviews (
    review_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title         TEXT NOT NULL,
    rating        INTEGER NOT NULL DEFAULT 5,
    body          TEXT,
    created_dt    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_dt    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
