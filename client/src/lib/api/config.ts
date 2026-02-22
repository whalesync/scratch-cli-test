import axios, { AxiosInstance } from 'axios';

/**
 * Singleton providing base configuration values for all the API calls.
 */
class ApiConfig {
  private apiUrl: string;
  private tokenProvider: (() => Promise<string | null>) | null = null;
  private snapshotWebsocketToken: string | null;
  // Axios instance calls to the API server
  private apiAxiosInstance: AxiosInstance | null = null;

  constructor() {
    this.apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3010';
    this.snapshotWebsocketToken = null;
  }

  public getApiUrl() {
    return this.apiUrl;
  }

  public setTokenProvider(provider: (() => Promise<string | null>) | null) {
    this.tokenProvider = provider;
  }

  /**
   * Get or create an axios instance configured with base URL and auth headers.
   * The request interceptor calls the token provider on every request to get a fresh token.
   */
  public getAxiosInstance(): AxiosInstance {
    if (!this.apiAxiosInstance) {
      this.apiAxiosInstance = axios.create({
        baseURL: this.apiUrl,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      // Add async request interceptor to fetch a fresh token per request
      this.apiAxiosInstance.interceptors.request.use(async (config) => {
        const token = await this.tokenProvider?.();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      });
    }
    return this.apiAxiosInstance;
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
