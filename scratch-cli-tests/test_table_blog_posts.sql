CREATE TABLE integration_blog_posts (
    post_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title       TEXT NOT NULL,
    content     TEXT,
    created_dt  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_dt  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    author      TEXT NOT NULL,
    publish_status TEXT NOT NULL DEFAULT 'draft'
);