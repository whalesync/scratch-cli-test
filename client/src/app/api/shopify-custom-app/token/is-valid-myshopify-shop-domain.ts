// Shopify's documented shop-domain pattern, anchored at both ends so nothing (path, port, userinfo,
// extra host labels) can ride along and redirect the token exchange to another host.
const MYSHOPIFY_SHOP_DOMAIN_PATTERN_ANCHORED_AT_BOTH_ENDS = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;

export function isValidMyshopifyShopDomain(shopDomainCandidate: string): boolean {
  return MYSHOPIFY_SHOP_DOMAIN_PATTERN_ANCHORED_AT_BOTH_ENDS.test(shopDomainCandidate);
}
