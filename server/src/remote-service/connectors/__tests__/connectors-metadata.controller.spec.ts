import { ScratchConfigService } from '../../../config/scratch-config.service';
import { ConnectorsMetadataController } from '../connectors-metadata.controller';
// Import the connectors exercised below so they self-register into the connector
// registry that getMetadata() reads: Webflow (OAuth gated ON in non-prod), Pipedrive
// (OAuth disabled in every environment), plus Shopify (relative setup-guide link).
import '../library/clickup/clickup-connector';
import '../library/pipedrive/pipedrive-connector';
import '../library/shopify/shopify-connector';
import '../library/webflow/webflow-connector';
import { Service } from '../service-constants';

const TEST_WEB_CLIENT_BASE_URL = 'https://app.example-scratch.md';

function makeControllerForEnvironment(isProductionEnvironment: boolean): ConnectorsMetadataController {
  const config = {
    isProductionEnvironment: () => isProductionEnvironment,
    getScratchApplicationUrl: () => TEST_WEB_CLIENT_BASE_URL,
  } as unknown as ScratchConfigService;
  return new ConnectorsMetadataController(config);
}

describe('ConnectorsMetadataController.getMetadata — environment-gated OAuth visibility', () => {
  describe('Pipedrive', () => {
    // The public Pipedrive marketplace app isn't approved yet, so OAuth is disabled at the source
    // (no `oauth` metadata, 'oauth' omitted from supportedAuthMethods) and hidden in EVERY
    // environment — not just production. (DEV-11051)
    it.each([
      ['production', true],
      ['non-production (test/staging/dev)', false],
    ])('hides OAuth in %s (API key only)', (_label, isProductionEnvironment) => {
      const pipedrive = makeControllerForEnvironment(isProductionEnvironment).getMetadata()[Service.PIPEDRIVE];
      expect(pipedrive.supportedAuthMethods).not.toContain('oauth');
      expect(pipedrive.supportedAuthMethods).toContain('user_provided_params');
      expect(pipedrive.defaultAuthMethod).toBe('user_provided_params');
      expect(pipedrive.oauth).toBeUndefined();
    });
  });

  describe('Webflow (existing precedent — unchanged)', () => {
    it('offers OAuth only in non-production', () => {
      const nonProd = makeControllerForEnvironment(false).getMetadata()[Service.WEBFLOW];
      const prod = makeControllerForEnvironment(true).getMetadata()[Service.WEBFLOW];
      expect(nonProd.supportedAuthMethods).toContain('oauth');
      expect(prod.supportedAuthMethods).not.toContain('oauth');
    });
  });

  describe('setup guide link resolution', () => {
    it("resolves Shopify's relative setup-guide URL against the web client base URL", () => {
      const shopify = makeControllerForEnvironment(false).getMetadata()[Service.SHOPIFY];
      expect(shopify.setupGuide?.url).toBe(`${TEST_WEB_CLIENT_BASE_URL}/shopify-custom-app`);
    });

    it('leaves absolute external setup-guide URLs untouched', () => {
      const clickup = makeControllerForEnvironment(false).getMetadata()[Service.CLICKUP];
      expect(clickup.setupGuide?.url).toBe('https://app.clickup.com/settings/apps');
    });
  });
});
