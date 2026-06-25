import { ScratchConfigService } from '../../../config/scratch-config.service';
import { ConnectorsMetadataController } from '../connectors-metadata.controller';
// Import the two connectors whose OAuth visibility is environment-gated so they
// self-register into the connector registry that getMetadata() reads.
import '../library/pipedrive/pipedrive-connector';
import '../library/webflow/webflow-connector';
import { Service } from '../service-constants';

function makeControllerForEnvironment(isProductionEnvironment: boolean): ConnectorsMetadataController {
  const config = {
    isProductionEnvironment: () => isProductionEnvironment,
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
});
