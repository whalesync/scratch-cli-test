import type { ConnectorMetadata } from '../../connector/metadata';
import type { Service } from '../../enums/enums';
import type { Http } from '../http';

/**
 * Connector metadata catalog — the static, per-connector descriptors the frontends render generically.
 * The web client and the desktop app hit the SAME `GET /connectors/metadata` endpoint with the same
 * response shape (a `Service`-keyed map; `Service` is a string alias, so desktop's
 * `Record<string, ConnectorMetadata>` and web's `Record<Service, ConnectorMetadata>` are identical).
 * Reached as `client.connectorsMetadata.*`.
 */
export function createConnectorsMetadataApi(http: Http) {
  return {
    getAll: async (): Promise<Record<Service, ConnectorMetadata>> => {
      const res = await http.get<Record<Service, ConnectorMetadata>>('/connectors/metadata', {
        fallbackMessage: 'Failed to fetch connector metadata',
      });
      return res.data;
    },
  };
}

export type ConnectorsMetadataApi = ReturnType<typeof createConnectorsMetadataApi>;
