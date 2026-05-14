import axios, { AxiosInstance, InternalAxiosRequestConfig, isAxiosError } from 'axios';

type RequestConfigWithTiming = InternalAxiosRequestConfig & {
  metadata?: { startedAt: number };
};

const LOG_EXCLUDED_URLS = new Set(['/users/current', '/jobs/bulk-status']);

function isLoggableUrl(url: string): boolean {
  const path = (url.startsWith('/') ? url : `/${url}`).split('?')[0];
  return !LOG_EXCLUDED_URLS.has(path);
}

class ApiConfig {
  private apiUrl: string;
  private staticToken: string | null = null;
  private axiosInstance: AxiosInstance | null = null;
  private unauthorizedHandler: (() => void) | null = null;
  private activeWorkspacePath: string | null = null;

  constructor() {
    this.apiUrl = (import.meta.env.VITE_SCRATCH_API_URL as string) || 'http://localhost:3010';
  }

  public getApiUrl() {
    return this.apiUrl;
  }

  public setStaticToken(token: string | null) {
    this.staticToken = token;
  }

  public setUnauthorizedHandler(handler: (() => void) | null) {
    this.unauthorizedHandler = handler;
  }

  public setActiveWorkspacePath(path: string | null) {
    this.activeWorkspacePath = path;
  }

  private logCall(config: RequestConfigWithTiming, status: number | undefined, errorSummary?: string) {
    const workspacePath = this.activeWorkspacePath;
    if (!workspacePath) return;
    const desktopApi = window.scratchDesktop;
    if (!desktopApi?.logApiCall) return;
    const url = config.url ?? '';
    if (!isLoggableUrl(url)) return;
    const startedAt = config.metadata?.startedAt ?? performance.now();
    desktopApi.logApiCall(workspacePath, {
      method: (config.method ?? 'GET').toUpperCase(),
      url,
      status,
      durationMs: performance.now() - startedAt,
      errorSummary,
    });
  }

  public getAxiosInstance(): AxiosInstance {
    if (!this.axiosInstance) {
      this.axiosInstance = axios.create({
        baseURL: this.apiUrl,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      this.axiosInstance.interceptors.request.use((config) => {
        if (this.staticToken) {
          config.headers.Authorization = `API-Token ${this.staticToken}`;
        }
        (config as RequestConfigWithTiming).metadata = { startedAt: performance.now() };
        return config;
      });

      this.axiosInstance.interceptors.response.use(
        (response) => {
          this.logCall(response.config as RequestConfigWithTiming, response.status);
          return response;
        },
        (error: unknown) => {
          if (isAxiosError(error)) {
            const config = (error.config ?? {}) as RequestConfigWithTiming;
            const responseStatus = error.response?.status;
            const responseData: unknown = error.response?.data;
            const summary =
              typeof responseData === 'string'
                ? responseData
                : responseData && typeof responseData === 'object' && 'message' in responseData
                  ? String((responseData as { message: unknown }).message)
                  : error.message;
            this.logCall(config, responseStatus, summary);
            if (responseStatus === 401 && this.staticToken) {
              this.unauthorizedHandler?.();
            }
          }
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    }
    return this.axiosInstance;
  }

  public getUnauthenticatedAxiosInstance(): AxiosInstance {
    return axios.create({
      baseURL: this.apiUrl,
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }
}

export const API_CONFIG = new ApiConfig();
