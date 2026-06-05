// Contracts for the internal, admin-only Whalesync → Scratch channel (`/internal/whalesync/*`).
// The server's DTO classes implement the request interface with class-validator decorators.

// ── Request DTOs ──────────────────────────────────────────────────────────────

export interface WhalesyncShadowUserDto {
  whalesyncUserId: string;
  email: string;
  name?: string;
}

// ── Response Entities ─────────────────────────────────────────────────────────

export interface WhalesyncSessionResponse {
  scratchUserId: string;
  apiToken: string;
  /** UTC ISO-8601 timestamp; the token expires 10 minutes after it is minted. */
  expiresAt: string;
}

export interface WhalesyncUserResponse {
  scratchUserId: string;
}

export interface WhalesyncRevokeSessionsResponse {
  revoked: number;
}
