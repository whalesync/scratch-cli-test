import axios, { AxiosInstance, isAxiosError } from 'axios';

class ApiConfig {
  private apiUrl: string;
  private staticToken: string | null = null;
  private axiosInstance: AxiosInstance | null = null;
  private unauthorizedHandler: (() => void) | null = null;

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
        return config;
      });

      this.axiosInstance.interceptors.response.use(
        (response) => response,
        (error: unknown) => {
          if (isAxiosError(error) && error.response?.status === 401 && this.staticToken) {
            this.unauthorizedHandler?.();
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
