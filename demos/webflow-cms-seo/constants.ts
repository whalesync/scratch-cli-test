// Shared identity of the demo Blog Posts collection.
// Kept in its own module (not in seed.ts) so reset.ts can import it WITHOUT pulling in
// seed.ts's executable body.

export const DEMO_BLOG_COLLECTION_SLUG = 'demo-blog-posts';
export const DEMO_BLOG_COLLECTION_DISPLAY_NAME = 'Blog Posts (Demo)';
export const DEMO_BLOG_COLLECTION_SINGULAR_NAME = 'Blog Post';
