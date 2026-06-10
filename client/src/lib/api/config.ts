/**
 * App-local configuration singleton. The REST layer now lives in the shared client
 * (`@/lib/api/scratch-api-client`); what remains here is the API base URL and the snapshot
 * WebSocket token, which the WebSocket layer (`stores/workbook-websocket-store.ts`) still owns
 * locally — WebSocket support is intentionally not part of the shared client yet.
 */
class ApiConfig {
  private apiUrl: string;
  private snapshotWebsocketToken: string | null;

  constructor() {
    this.apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3010';
    this.snapshotWebsocketToken = null;
  }

  public getApiUrl() {
    return this.apiUrl;
  }

  getApiServerHealthUrl() {
    return `${this.apiUrl}/health`;
  }

  public setSnapshotWebsocketToken(token: string) {
    this.snapshotWebsocketToken = token;
  }

  public getSnapshotWebsocketToken() {
    return this.snapshotWebsocketToken;
  }
}

export const API_CONFIG = new ApiConfig();
