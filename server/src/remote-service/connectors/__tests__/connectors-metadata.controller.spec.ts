import { ScratchConfigService } from '../../../config/scratch-config.service';
import { ConnectorsMetadataController } from '../connectors-metadata.controller';
// Import the connectors exercised below so they self-register into the connector
// registry that getMetadata() reads: the two whose OAuth visibility is
// environment-gated, plus Shopify (whose setup-guide link is a relative path).
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
    it('hides OAuth in production (API key only)', () => {
      const pipedrive = makeControllerForEnvironment(true).getMetadata()[Service.PIPEDRIVE];
      expect(pipedrive.supportedAuthMethods).not.toContain('oauth');
      expect(pipedrive.supportedAuthMethods).toContain('user_provided_params');
      expect(pipedrive.defaultAuthMethod).toBe('user_provided_params');
      expect(pipedrive.oauth).toBeUndefined();
    });

    it('offers OAuth in non-production (test/staging/dev)', () => {
      const pipedrive = makeControllerForEnvironment(false).getMetadata()[Service.PIPEDRIVE];
      expect(pipedrive.supportedAuthMethods).toContain('oauth');
      expect(pipedrive.oauth?.label).toBe('OAuth');
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
