// Contracts for the internal, admin-only Whalesync → Scratch channel (`/internal/whalesync/*`).
// Request bodies are validated server-side via the shared zod schema (createZodDto bridge).
import { z } from 'zod';

// ── Request DTOs ──────────────────────────────────────────────────────────────

export const whalesyncShadowUserSchema = z.object({
  whalesyncUserId: z.string().min(1),
  email: z.string().min(1),
  name: z.string().optional(),
});

export type WhalesyncShadowUserDto = z.infer<typeof whalesyncShadowUserSchema>;

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
