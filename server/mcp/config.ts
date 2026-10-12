import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { isMcpScope, MCP_CONSENT_PATH, MCP_PATH, MCP_SCOPES, type McpScope } from "../../shared/mcpConnector";
import { ENV } from "../_core/env";

/** Claude's OAuth callbacks (claude.ai and claude.com); every other non-loopback redirect URI is refused. */
export const CLAUDE_REDIRECT_URIS = ["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"] as const;

export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;
export const AUTH_REQUEST_TTL_MS = 10 * 60_000;
export const AUTH_CODE_TTL_MS = 2 * 60_000;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Origin of this API as clients see it: PUBLIC_API_URL, else the (proxy-aware) request origin. */
export function apiBaseUrl(req: Pick<Request, "protocol" | "headers">): string {
  if (ENV.publicApiUrl) return ENV.publicApiUrl;
  const header = (name: string) => {
    const v = req.headers?.[name];
    return (Array.isArray(v) ? v[0] : v)?.split(",")[0]?.trim();
  };
  return `${req.protocol || "https"}://${header("x-forwarded-host") || header("host") || "localhost:3000"}`;
}

export const mcpResourceUrl = (base: string) => `${base}${MCP_PATH}`;
export const protectedResourceMetadataUrl = (base: string) => `${base}/.well-known/oauth-protected-resource${MCP_PATH}`;

/** The consent page: on the separately hosted frontend, or on this host when it also serves the SPA. */
export function consentPageUrl(base: string, requestId: string): string {
  return `${ENV.frontendUrl || base}${MCP_CONSENT_PATH}?request=${encodeURIComponent(requestId)}`;
}

export const frontendBase = (base: string) => ENV.frontendUrl || base;

/** RFC 8707 resource indicators compare without a fragment and without one trailing slash. */
export function sameResource(a: string, b: string): boolean {
  const norm = (v: string) => (v.split("#")[0] ?? "").replace(/\/$/, "");
  return norm(a) === norm(b);
}

function isLoopback(uri: URL) {
  return uri.protocol === "http:" && LOOPBACK_HOSTS.has(uri.hostname);
}

/** Whether a client may register this redirect URI: Claude's callbacks, configured extras, loopback when enabled. */
export function isAllowedRedirectUri(raw: string): boolean {
  let uri: URL;
  try {
    uri = new URL(raw);
  } catch {
    return false;
  }
  if (uri.hash) return false;
  if ((CLAUDE_REDIRECT_URIS as readonly string[]).includes(raw)) return true;
  if (ENV.mcpExtraRedirectUris.includes(raw)) return true;
  return ENV.mcpAllowLoopbackRedirects && isLoopback(uri);
}

/** RFC 8252 §7.3: loopback redirect URIs match on any port; everything else matches exactly. */
export function redirectUriMatches(requested: string, registered: string): boolean {
  if (requested === registered) return true;
  try {
    const a = new URL(requested);
    const b = new URL(registered);
    return isLoopback(a) && isLoopback(b) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

/** Space-separated scope string → known scopes; empty = every scope. Null when any scope is unknown. */
export function parseScopes(raw: string | undefined | null): McpScope[] | null {
  const parts = (raw ?? "").split(" ").map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return [...MCP_SCOPES];
  if (!parts.every(isMcpScope)) return null;
  return MCP_SCOPES.filter((s) => parts.includes(s));
}

export const scopeString = (scopes: readonly string[]) => scopes.join(" ");

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export function newSecret(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

export function sameHash(value: string, hash: string): boolean {
  const a = Buffer.from(sha256(value), "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** PKCE S256 (RFC 7636): BASE64URL(SHA256(verifier)) must equal the challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

export const PKCE_CHALLENGE_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
