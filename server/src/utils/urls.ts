export function isValidHttpUrl(str: string): boolean {
  const pattern = new RegExp(
    '^(https?:\\/\\/)?' + // protocol
      '((([a-z\\d]([a-z\\d-]*[a-z\\d])*)\\.)+[a-z]{2,}|' + // domain name
      '((\\d{1,3}\\.){3}\\d{1,3}))' + // OR ip (v4) address
      '(\\:\\d+)?(\\/[-a-z\\d%_.~+]*)*' + // port and path
      '(\\?[;&a-z\\d%_.~+=-]*)?' + // query string
      '(\\#[-a-z\\d_]*)?$', // fragment locator
    'i',
  );
  return pattern.test(str);
}

/**
 * Returns the hostname of a URL with a leading `www.` stripped, for use as an
 * analytics breakdown key. Subdomains other than `www` are preserved
 * (`api.example.co.uk` stays distinct from `example.co.uk`). Returns undefined
 * for inputs that don't parse as a URL.
 */
export function extractApiDomain(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return undefined;
  }
}
