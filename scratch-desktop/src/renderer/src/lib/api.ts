import axios, { AxiosInstance } from 'axios';

class ApiConfig {
  private apiUrl: string;
  private tokenProvider: (() => Promise<string | null>) | null = null;
  private axiosInstance: AxiosInstance | null = null;

  constructor() {
    this.apiUrl = (import.meta.env.VITE_SCRATCH_API_URL as string) || 'http://localhost:3010';
  }

  public getApiUrl() {
    return this.apiUrl;
  }

  public setTokenProvider(provider: (() => Promise<string | null>) | null) {
    this.tokenProvider = provider;
  }

  public getAxiosInstance(): AxiosInstance {
    if (!this.axiosInstance) {
      this.axiosInstance = axios.create({
        baseURL: this.apiUrl,
        headers: {
          'Content-Type': 'application/json',
        },
      });

      this.axiosInstance.interceptors.request.use(async (config) => {
        const token = await this.tokenProvider?.();
        if (token) {
          config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
      });
    }
    return this.axiosInstance;
  }
}

export const API_CONFIG = new ApiConfig();
