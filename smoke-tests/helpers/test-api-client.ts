import axios, { AxiosInstance, AxiosResponse } from 'axios';

type TokenRefresher = () => Promise<string>;

/**
 * Thin HTTP client for smoke tests. Wraps axios with auth and base URL.
 * Automatically refreshes the JWT when it expires (401).
 */
export class TestApiClient {
  private client: AxiosInstance;
  private refreshToken: TokenRefresher;

  constructor(baseUrl: string, authToken: string, refreshToken: TokenRefresher) {
    this.refreshToken = refreshToken;
    this.client = axios.create({
      baseURL: baseUrl,
      headers: {
        Authorization: `Bearer ${authToken}`,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true, // Don't throw on non-2xx — let tests assert status
    });

    // Auto-refresh on 401 (with infinite-loop guard)
    this.client.interceptors.response.use(async (response) => {
      if (response.status === 401 && !(response.config as any).__isRetry) {
        const newToken = await this.refreshToken();
        this.client.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;
        // Retry the original request with the new token
        const config = response.config;
        config.headers['Authorization'] = `Bearer ${newToken}`;
        (config as any).__isRetry = true;
        return this.client.request(config);
      }
      return response;
    });
  }

  async get<T = any>(path: string, params?: Record<string, string>): Promise<AxiosResponse<T>> {
    return this.client.get(path, { params });
  }

  async post<T = any>(path: string, data?: any): Promise<AxiosResponse<T>> {
    return this.client.post(path, data);
  }

  async patch<T = any>(path: string, data?: any, params?: Record<string, string>): Promise<AxiosResponse<T>> {
    return this.client.patch(path, data, { params });
  }

  async delete<T = any>(path: string, params?: Record<string, string>): Promise<AxiosResponse<T>> {
    return this.client.delete(path, { params });
  }
}

/**
 * Unauthenticated client for fake API test-admin endpoints.
 */
export class FakeAdminClient {
  private client: AxiosInstance;

  constructor(baseUrl: string) {
    this.client = axios.create({
      baseURL: baseUrl,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async reset(): Promise<void> {
    await this.client.post('/test/reset');
  }

  async setup(data: { bases?: any[]; tables?: any[]; records?: any[] }): Promise<void> {
    await this.client.post('/test/setup', data);
  }

  async dump(baseId?: string, tableId?: string): Promise<any> {
    const params: Record<string, string> = {};
    if (baseId) params.baseId = baseId;
    if (tableId) params.tableId = tableId;
    const res = await this.client.get('/test/dump', { params });
    return res.data;
  }

  async simulateRateLimit(count: number, retryAfterSeconds: number = 1): Promise<void> {
    await this.client.post('/test/simulate-rate-limit', { count, retryAfterSeconds });
  }

  async simulateError(statusCode: number, body: any): Promise<void> {
    await this.client.post('/test/simulate-error', { statusCode, body });
  }
}
