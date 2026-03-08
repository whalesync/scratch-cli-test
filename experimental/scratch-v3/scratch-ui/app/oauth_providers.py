"""OAuth provider definitions. Pure data — reads client IDs/secrets from env.

Each provider defines: authorize_url, token_url, scopes, token_content_type,
and how to build the auth header for the token exchange.

To remove: delete this file. Nothing else imports it except app/routes/oauth.py.
"""

from __future__ import annotations

import base64
import os
from dataclasses import dataclass, field


@dataclass
class OAuthProviderConfig:
    authorize_url: str
    token_url: str
    scopes: list[str] = field(default_factory=list)
    # How the token endpoint expects credentials
    # "basic" = Basic auth header with client_id:client_secret
    # "body"  = client_id and client_secret in the POST body
    token_auth: str = "basic"
    # Content type for token exchange: "json" or "form"
    token_content_type: str = "form"
    # Whether this provider uses PKCE (code_challenge / code_verifier)
    pkce: bool = False

    def client_id(self, service: str) -> str:
        return os.environ.get(f"{service.upper()}_CLIENT_ID", "")

    def client_secret(self, service: str) -> str:
        return os.environ.get(f"{service.upper()}_CLIENT_SECRET", "")

    def token_headers(self, service: str) -> dict[str, str]:
        headers: dict[str, str] = {}
        if self.token_content_type == "form":
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        else:
            headers["Content-Type"] = "application/json"
        if self.token_auth == "basic":
            cid = self.client_id(service)
            secret = self.client_secret(service)
            b64 = base64.b64encode(f"{cid}:{secret}".encode()).decode()
            headers["Authorization"] = f"Basic {b64}"
        return headers


def redirect_uri() -> str:
    return os.environ.get("REDIRECT_URI", "")


# ---- Provider registry ----

PROVIDERS: dict[str, OAuthProviderConfig] = {
    "airtable": OAuthProviderConfig(
        authorize_url="https://airtable.com/oauth2/v1/authorize",
        token_url="https://airtable.com/oauth2/v1/token",
        scopes=["data.records:read", "data.records:write", "schema.bases:read"],
        pkce=True,
    ),
    "notion": OAuthProviderConfig(
        authorize_url="https://api.notion.com/v1/oauth/authorize",
        token_url="https://api.notion.com/v1/oauth/token",
        token_content_type="json",
    ),
    "webflow": OAuthProviderConfig(
        authorize_url="https://webflow.com/oauth/authorize",
        token_url="https://api.webflow.com/oauth/access_token",
        scopes=[
            "authorized_user:read",
            "cms:read",
            "cms:write",
            "pages:read",
            "pages:write",
            "sites:read",
            "sites:write",
        ],
        token_auth="body",
        token_content_type="json",
    ),
    "youtube": OAuthProviderConfig(
        authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
        token_url="https://oauth2.googleapis.com/token",
        scopes=["https://www.googleapis.com/auth/youtube.readonly"],
        token_auth="body",
    ),
    "wix_blog": OAuthProviderConfig(
        authorize_url="https://www.wix.com/installer/install",
        token_url="https://www.wixapis.com/oauth/access",
        scopes=["site.blog"],
        token_auth="body",
        token_content_type="json",
    ),
    "shopify": OAuthProviderConfig(
        authorize_url="https://{shop_domain}/admin/oauth/authorize",
        token_url="https://{shop_domain}/admin/oauth/access_token",
        scopes=["read_products", "write_products"],
        token_auth="body",
        token_content_type="json",
    ),
    "supabase": OAuthProviderConfig(
        authorize_url="https://api.supabase.com/v1/oauth/authorize",
        token_url="https://api.supabase.com/v1/oauth/token",
    ),
}
