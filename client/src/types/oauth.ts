import { Service } from '@spinner/shared-types';

export interface OAuthInitiateResponse {
  authUrl: string;
  state: string;
}

export interface OAuthCallbackRequest {
  code: string;
  state: string;
}

export interface OAuthCallbackResponse {
  connectorAccountId: string;
}

export type OAuthService =
  | Service.NOTION
  | Service.AIRTABLE
  | Service.YOUTUBE
  | Service.WEBFLOW
  | Service.WIX_BLOG
  | Service.SHOPIFY
  | Service.SUPABASE
  | Service.QUICKBOOKS;

export interface OAuthError {
  error: string;
  error_description?: string;
}
