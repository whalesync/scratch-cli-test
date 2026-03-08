"""OAuth routes: initiate, callback, and token refresh.

Self-contained — depends only on app.crypto, app.oauth_providers, and app.db.
To remove: delete this file, app/crypto.py, and app/oauth_providers.py.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request

from app import db
from app.crypto import decrypt_obj, encrypt_obj
from app.oauth_providers import PROVIDERS, redirect_uri

router = APIRouter(prefix="/oauth", tags=["oauth"])

_MASTER_KEY = os.environ.get("ENCRYPTION_MASTER_KEY", "")


def _require_master_key() -> str:
    if not _MASTER_KEY or len(_MASTER_KEY) < 32:
        raise HTTPException(500, "ENCRYPTION_MASTER_KEY not configured (must be >= 32 chars)")
    return _MASTER_KEY


# ---------------------------------------------------------------------------
# Initiate
# ---------------------------------------------------------------------------


@router.post("/{service}/initiate")
async def initiate(service: str, request: Request):
    """Start OAuth flow. Returns {authUrl} for the frontend to redirect to."""
    provider = PROVIDERS.get(service)
    if not provider:
        raise HTTPException(400, f"Unsupported OAuth service: {service}")

    body = await request.json()
    workbook_id = body.get("workbookId", "")

    # PKCE for providers that need it (e.g. Airtable)
    code_verifier = None
    code_challenge = None
    if provider.pkce:
        code_verifier = secrets.token_urlsafe(96)
        code_challenge = (
            base64.urlsafe_b64encode(hashlib.sha256(code_verifier.encode()).digest()).rstrip(b"=").decode()
        )

    # Pack state as base64 JSON (same format as NestJS)
    state_payload = {
        "workbookId": workbook_id,
        "service": service,
        "codeVerifier": code_verifier,
        "ts": int(datetime.now(timezone.utc).timestamp() * 1000),
    }
    state = base64.b64encode(json.dumps(state_payload).encode()).decode()

    # Build authorize URL
    client_id = provider.client_id(service)
    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri(),
        "response_type": "code",
        "state": state,
    }
    if provider.scopes:
        params["scope"] = " ".join(provider.scopes)
    if code_challenge:
        params["code_challenge"] = code_challenge
        params["code_challenge_method"] = "S256"

    # Notion uses "owner=user" param
    if service == "notion":
        params["owner"] = "user"

    auth_url = f"{provider.authorize_url}?{urlencode(params)}"
    return {"authUrl": auth_url}


# ---------------------------------------------------------------------------
# Callback
# ---------------------------------------------------------------------------


@router.post("/{service}/callback")
async def callback(service: str, request: Request):
    """Exchange auth code for tokens. Stores encrypted credentials in SQLite."""
    provider = PROVIDERS.get(service)
    if not provider:
        raise HTTPException(400, f"Unsupported OAuth service: {service}")

    master_key = _require_master_key()
    body = await request.json()
    code = body.get("code", "")
    state_b64 = body.get("state", "")

    if not code:
        raise HTTPException(400, "Missing authorization code")

    # Decode state
    try:
        state_payload = json.loads(base64.b64decode(state_b64))
    except Exception:
        raise HTTPException(400, "Invalid state parameter")

    workbook_id = state_payload.get("workbookId", "")
    code_verifier = state_payload.get("codeVerifier")

    # Exchange code for tokens
    token_data = await _exchange_code(service, provider, code, code_verifier)
    access_token = token_data.get("access_token", "")
    if not access_token:
        raise HTTPException(502, f"Token exchange failed: {json.dumps(token_data)}")

    # Build credentials object (same shape as NestJS DecryptedCredentials)
    credentials = {
        "oauthAccessToken": access_token,
        "oauthRefreshToken": token_data.get("refresh_token"),
        "oauthExpiresAt": _expires_at(token_data.get("expires_in")),
        "oauthWorkspaceId": token_data.get("workspace_id"),
    }
    encrypted = encrypt_obj(credentials, master_key)

    # Upsert connector account
    conn_id = _save_connection(workbook_id, service, encrypted)
    return {"connectorAccountId": conn_id}


# ---------------------------------------------------------------------------
# Refresh
# ---------------------------------------------------------------------------


@router.post("/refresh")
async def refresh(request: Request):
    """Refresh tokens for a connector account."""
    master_key = _require_master_key()
    body = await request.json()
    connector_account_id = body.get("connectorAccountId", "")

    conn = _get_connection(connector_account_id)
    if not conn:
        raise HTTPException(404, "Connector account not found")

    encrypted_creds = _parse_encrypted(conn)
    creds = decrypt_obj(encrypted_creds, master_key)

    refresh_token = creds.get("oauthRefreshToken")
    if not refresh_token:
        raise HTTPException(400, "No refresh token available")

    service = conn.get("service", "")
    provider = PROVIDERS.get(service)
    if not provider:
        raise HTTPException(400, f"No OAuth provider for service: {service}")

    token_data = await _refresh_tokens(service, provider, refresh_token)

    # Update credentials
    creds["oauthAccessToken"] = token_data.get("access_token", creds.get("oauthAccessToken"))
    if token_data.get("refresh_token"):
        creds["oauthRefreshToken"] = token_data["refresh_token"]
    creds["oauthExpiresAt"] = _expires_at(token_data.get("expires_in"))

    encrypted = encrypt_obj(creds, master_key)
    _update_encrypted_credentials(connector_account_id, encrypted)
    return {"success": True}


# ---------------------------------------------------------------------------
# Get valid access token (used by connectors)
# ---------------------------------------------------------------------------


async def get_valid_access_token(connector_account_id: str) -> str:
    """Get a valid access token, refreshing if expired. Called by connector instantiation."""
    master_key = _require_master_key()

    conn = _get_connection(connector_account_id)
    if not conn:
        raise ValueError(f"Connector account {connector_account_id} not found")

    encrypted_creds = _parse_encrypted(conn)
    creds = decrypt_obj(encrypted_creds, master_key)

    access_token = creds.get("oauthAccessToken", "")
    if not access_token:
        raise ValueError("No access token available")

    # Check expiry with 5-minute buffer
    expires_at = creds.get("oauthExpiresAt")
    if expires_at and _is_expired(expires_at):
        refresh_token = creds.get("oauthRefreshToken")
        if not refresh_token:
            raise ValueError("Token expired and no refresh token available")

        service = conn.get("service", "")
        provider = PROVIDERS.get(service)
        if not provider:
            raise ValueError(f"No OAuth provider for service: {service}")

        token_data = await _refresh_tokens(service, provider, refresh_token)
        creds["oauthAccessToken"] = token_data.get("access_token", access_token)
        if token_data.get("refresh_token"):
            creds["oauthRefreshToken"] = token_data["refresh_token"]
        creds["oauthExpiresAt"] = _expires_at(token_data.get("expires_in"))

        encrypted = encrypt_obj(creds, master_key)
        _update_encrypted_credentials(connector_account_id, encrypted)
        return creds["oauthAccessToken"]

    return access_token


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _exchange_code(
    service: str,
    provider,
    code: str,
    code_verifier: str | None,
) -> dict:
    headers = provider.token_headers(service)
    payload: dict = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri(),
    }
    if provider.token_auth == "body":
        payload["client_id"] = provider.client_id(service)
        payload["client_secret"] = provider.client_secret(service)
    else:
        # Basic auth providers still send client_id in body (Airtable needs it)
        payload["client_id"] = provider.client_id(service)
    if code_verifier:
        payload["code_verifier"] = code_verifier

    async with httpx.AsyncClient() as client:
        if provider.token_content_type == "form":
            resp = await client.post(provider.token_url, data=payload, headers=headers)
        else:
            resp = await client.post(provider.token_url, json=payload, headers=headers)
        resp.raise_for_status()
        return resp.json()


async def _refresh_tokens(service: str, provider, refresh_token: str) -> dict:
    headers = provider.token_headers(service)
    payload: dict = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }
    if provider.token_auth == "body":
        payload["client_id"] = provider.client_id(service)
        payload["client_secret"] = provider.client_secret(service)
    else:
        payload["client_id"] = provider.client_id(service)

    async with httpx.AsyncClient() as client:
        if provider.token_content_type == "form":
            resp = await client.post(provider.token_url, data=payload, headers=headers)
        else:
            resp = await client.post(provider.token_url, json=payload, headers=headers)
        resp.raise_for_status()
        return resp.json()


def _expires_at(expires_in: int | None) -> str | None:
    if not expires_in:
        return None
    return (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat()


def _is_expired(expires_at: str) -> bool:
    try:
        exp = datetime.fromisoformat(expires_at)
        buffer = timedelta(minutes=5)
        return datetime.now(timezone.utc) >= exp.replace(tzinfo=timezone.utc) - buffer
    except (ValueError, TypeError):
        return False


def _save_connection(workbook_id: str, service: str, encrypted: dict) -> str:
    """Create a connector_account row. Returns the ID."""
    conn = db.get_db()
    import secrets as _s
    conn_id = f"coa_{_s.token_urlsafe(8)}"
    conn.execute(
        "INSERT INTO connector_account (id, workbook_id, service, display_name, auth_type) VALUES (?, ?, ?, ?, ?)",
        (conn_id, workbook_id, service, f"{service} (OAuth)", "OAUTH"),
    )
    # Store encrypted creds as JSON in a column we need to add
    _ensure_encrypted_column(conn)
    conn.execute(
        "UPDATE connector_account SET encrypted_credentials = ? WHERE id = ?",
        (json.dumps(encrypted), conn_id),
    )
    conn.commit()
    conn.close()
    return conn_id


def _get_connection(conn_id: str) -> dict | None:
    conn = db.get_db()
    _ensure_encrypted_column(conn)
    row = conn.execute("SELECT * FROM connector_account WHERE id = ?", (conn_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def _parse_encrypted(conn_row: dict) -> dict:
    raw = conn_row.get("encrypted_credentials", "{}")
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return {}
    return raw or {}


def _update_encrypted_credentials(conn_id: str, encrypted: dict) -> None:
    conn = db.get_db()
    _ensure_encrypted_column(conn)
    conn.execute(
        "UPDATE connector_account SET encrypted_credentials = ? WHERE id = ?",
        (json.dumps(encrypted), conn_id),
    )
    conn.commit()
    conn.close()


def _ensure_encrypted_column(conn) -> None:
    """Add encrypted_credentials column if it doesn't exist yet."""
    try:
        conn.execute("SELECT encrypted_credentials FROM connector_account LIMIT 0")
    except Exception:
        conn.execute("ALTER TABLE connector_account ADD COLUMN encrypted_credentials TEXT DEFAULT '{}'")
