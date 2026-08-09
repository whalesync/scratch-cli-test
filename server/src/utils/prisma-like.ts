/**
 * Escape the SQL `LIKE` wildcards `\`, `%`, and `_` in a value so Prisma's
 * `startsWith` / `contains` / `endsWith` string filters match it LITERALLY.
 *
 * Those filters compile to `col LIKE '<value>%'` on PostgreSQL and Prisma does NOT
 * escape the value, so an `_` (matches any one char) or `%` (matches any run) inside
 * a user-derived value — very common in folder/table names like `product_variants`
 * — acts as a wildcard and over-matches rows outside the intended prefix. PostgreSQL
 * `LIKE` uses `\` as its default escape character, so prepending `\` to each
 * metacharacter (in a single pass) makes them literal.
 *
 * Use this on any value passed to a Prisma `startsWith`/`contains`/`endsWith` that
 * must be an exact substring — especially before a delete, where over-matching means
 * over-deletion.
 */
export function escapeLikeWildcards(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}
