/** One DNS label: letters, digits, and inner hyphens, 1 to 63 characters. */
const PLAIN_DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/**
 * Whether a value is a single plain DNS label. A connector that puts a value into a hostname template
 * (`https://${subdomain}.mocoapp.com`) checks it with this first, so the value can only ever name a subdomain of the
 * service's own domain. Anything that could end the host early or move it (`.`, `/`, `?`, `#`, `@`, `:`, `\`), or
 * isn't text, is refused (DEV-12723).
 */
export function isPlainDnsLabel(value: unknown): value is string {
  return typeof value === 'string' && PLAIN_DNS_LABEL_PATTERN.test(value);
}
