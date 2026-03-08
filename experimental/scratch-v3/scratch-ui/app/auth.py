"""Clerk JWT authentication for scratch-ui.

Verifies Clerk-issued JWTs from:
  - Browser: __session cookie (set by Clerk.js)
  - CLI/API: Authorization: Bearer <token> header

Uses Clerk's JWKS endpoint to verify RS256 signatures.
"""

from __future__ import annotations

import base64
import logging
from dataclasses import dataclass

import jwt
from jwt import PyJWKClient

from app.config import settings

logger = logging.getLogger(__name__)

PUBLIC_PATHS = frozenset({"/sign-in", "/sign-out", "/static", "/favicon.ico"})


@dataclass
class AuthenticatedUser:
    clerk_id: str
    email: str | None = None
    name: str | None = None


def _clerk_domain() -> str:
    """Derive the Clerk domain from the publishable key.

    The publishable key is 'pk_test_<base64-encoded-domain>' or 'pk_live_<base64-encoded-domain>'.
    """
    key = settings.clerk_publishable_key
    if not key:
        raise RuntimeError("CLERK_PUBLISHABLE_KEY not configured")
    # Strip the pk_test_ or pk_live_ prefix
    encoded = key.split("_", 2)[-1]
    # Base64 decode (may need padding)
    padded = encoded + "=" * (-len(encoded) % 4)
    domain = base64.b64decode(padded).decode("utf-8").rstrip("$")
    return domain


_jwks_client: PyJWKClient | None = None


def _get_jwks_client() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        domain = _clerk_domain()
        jwks_url = f"https://{domain}/.well-known/jwks.json"
        _jwks_client = PyJWKClient(jwks_url, cache_keys=True)
    return _jwks_client


def verify_clerk_token(token: str) -> AuthenticatedUser:
    """Verify a Clerk JWT and return the authenticated user.

    Raises jwt.exceptions.PyJWTError on invalid/expired tokens.
    """
    client = _get_jwks_client()
    signing_key = client.get_signing_key_from_jwt(token)
    payload = jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256"],
        options={"verify_aud": False},
    )
    return AuthenticatedUser(
        clerk_id=payload["sub"],
        email=payload.get("email"),
        name=payload.get("name"),
    )


def _verify_api_token(token: str) -> AuthenticatedUser | None:
    """Verify a static API token (sk_...) against the database.

    Returns AuthenticatedUser if valid, None otherwise.
    """
    from app.db import verify_api_token as db_verify

    user_row = db_verify(token)
    if not user_row:
        return None
    return AuthenticatedUser(
        clerk_id=user_row["clerk_id"],
        email=user_row.get("email"),
        name=user_row.get("name"),
    )


def _authenticate(token: str) -> AuthenticatedUser | None:
    """Try API token first (cheap DB lookup), then Clerk JWT (network call)."""
    if token.startswith("sk_"):
        return _verify_api_token(token)

    try:
        return verify_clerk_token(token)
    except Exception as e:
        logger.debug("JWT verification failed: %s", e)
        return None


def _extract_token(request) -> str | None:
    """Extract token from Authorization header or __session cookie."""
    # Check Authorization header first (CLI/API clients)
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        return auth_header[7:].strip()

    # Fall back to Clerk session cookie (browser)
    return request.cookies.get("__session")


def _is_public_path(path: str) -> bool:
    """Check if the request path is public (no auth required)."""
    if path in PUBLIC_PATHS:
        return True
    for prefix in PUBLIC_PATHS:
        if path.startswith(prefix + "/"):
            return True
    return False


def _is_api_request(request) -> bool:
    """Check if this is a JSON API request (vs browser HTML request)."""
    return request.url.path.startswith("/api/")


async def auth_middleware(request, call_next):
    """Starlette middleware: verify auth, set request.state.user, handle redirects/401s."""
    from starlette.responses import JSONResponse, RedirectResponse

    path = request.url.path

    if _is_public_path(path):
        request.state.user = None
        return await call_next(request)

    token = _extract_token(request)
    if token:
        user = _authenticate(token)
        if user:
            request.state.user = user
            return await call_next(request)

    # Not authenticated
    request.state.user = None

    if _is_api_request(request):
        return JSONResponse({"detail": "Not authenticated"}, status_code=401)

    # Browser request — redirect to sign-in.
    # For HTMX partial requests, use HX-Redirect so the browser does a full redirect.
    if request.headers.get("HX-Request") == "true":
        response = JSONResponse(content="", status_code=200)
        response.headers["HX-Redirect"] = "/sign-in"
        return response

    return RedirectResponse(url="/sign-in", status_code=302)
