import axios, { AxiosInstance } from 'axios';

class ApiConfig {
  private apiUrl: string;
  private staticToken: string | null = null;
  private axiosInstance: AxiosInstance | null = null;

  constructor() {
    this.apiUrl = (import.meta.env.VITE_SCRATCH_API_URL as string) || 'http://localhost:3010';
  }

  public getApiUrl() {
    return this.apiUrl;
  }

  public setStaticToken(token: string | null) {
    this.staticToken = token;
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
