import type { Request, Response } from "express";
import { nanoid } from "nanoid";
import { z } from "zod";
import type { OAuthClientRow, OAuthTokenRow, ProviderWorkspace, User } from "../../drizzle/schema";
import { MCP_SCOPES, type McpScope } from "../../shared/mcpConnector";
import { hitRateLimit } from "../_core/rateLimit";
import { hashIp } from "../_core/requestMeta";
import { getUserById } from "../db";
import { managedWorkspaces, resolveWorkspace } from "../modules/access";
import { AppError } from "../modules/errors";
import { recordSecurityEvent } from "../modules/securityEvents";
import { recordMcpAudit } from "./audit";
import {
  ACCESS_TOKEN_TTL_MS,
  apiBaseUrl,
  AUTH_CODE_TTL_MS,
  AUTH_REQUEST_TTL_MS,
  consentPageUrl,
  isAllowedRedirectUri,
  mcpResourceUrl,
  newSecret,
  parseScopes,
  PKCE_CHALLENGE_PATTERN,
  pkceMatches,
  redirectUriMatches,
  REFRESH_TOKEN_TTL_MS,
  sameHash,
  sameResource,
  scopeString,
  sha256,
} from "./config";
import { assertMcpEntitled, mcpEntitlement } from "./entitlement";
import { oauthStore, type NewToken } from "./store";

const AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// Metadata (RFC 8414, RFC 9728)
// ---------------------------------------------------------------------------

export function authorizationServerMetadata(base: string) {
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    revocation_endpoint: `${base}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
    scopes_supported: [...MCP_SCOPES],
    service_documentation: "https://github.com/datacolabaz/resulio/blob/main/docs/MCP-CONNECTOR.md",
  };
}

export function protectedResourceMetadata(base: string) {
  return {
    resource: mcpResourceUrl(base),
    authorization_servers: [base],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Resulio",
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class OAuthFailure extends Error {
  constructor(
    public readonly error: string,
    public readonly description: string,
    public readonly status = 400,
  ) {
    super(description);
  }
}

function sendOAuthError(res: Response, failure: OAuthFailure) {
  res.set("Cache-Control", "no-store");
  if (failure.status === 401) res.set("WWW-Authenticate", 'Basic realm="resulio"');
  res.status(failure.status).json({ error: failure.error, error_description: failure.description });
}

function handle(fn: (req: Request, res: Response) => Promise<void>) {
  return async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (error) {
      if (error instanceof OAuthFailure) return sendOAuthError(res, error);
      console.error("[OAuth] unexpected error", error instanceof Error ? error.message : error);
      sendOAuthError(res, new OAuthFailure("server_error", "Internal error", 500));
    }
  };
}

function throttle(req: Request, name: string, key: string, limit: number, windowMs: number) {
  if (!hitRateLimit(`${name}:${key}`, limit, windowMs)) return;
  recordSecurityEvent({ type: "RATE_LIMIT_BLOCK", severity: "LOW", ipHash: hashIp(req.ip), details: { limiter: name } });
  throw new OAuthFailure("slow_down", "Too many requests, try again later", 429);
}

const ipKey = (req: Request) => `ip:${req.ip ?? "unknown"}`;

function str(value: unknown, max = 2048): string | undefined {
  return typeof value === "string" && value.length <= max ? value : undefined;
}

/** Client authentication at the token and revocation endpoints: Basic header, body secret, or none for public clients. */
async function authenticateClient(req: Request): Promise<OAuthClientRow> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  let clientId = str(body.client_id, 64);
  let secret = str(body.client_secret, 256);
  const header = req.get("authorization");
  if (header?.toLowerCase().startsWith("basic ")) {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const sep = decoded.indexOf(":");
    if (sep < 0) throw new OAuthFailure("invalid_client", "Malformed Basic credentials", 401);
    clientId = decodeURIComponent(decoded.slice(0, sep));
    secret = decodeURIComponent(decoded.slice(sep + 1));
  }
  if (!clientId) throw new OAuthFailure("invalid_client", "client_id is required", 401);
  const client = await oauthStore().getClient(clientId);
  if (!client) throw new OAuthFailure("invalid_client", "Unknown client", 401);
  if (client.secretHash) {
    if (!secret || !sameHash(secret, client.secretHash)) throw new OAuthFailure("invalid_client", "Invalid client credentials", 401);
  } else if (secret) {
    throw new OAuthFailure("invalid_client", "Public clients have no secret", 401);
  }
  return client;
}

export type ConnectorSubject = { user: User; workspace: ProviderWorkspace };

/**
 * Who a grant acts for, re-checked at consent, at every token exchange and on every MCP request:
 * an existing, active account that still owns the workspace (the same ownership check as
 * teacherProcedure) and has an active connector subscription. Tokens issued before the user's
 * sessionsValidAfter (an admin or the user signed out everywhere) are refused like session cookies.
 */
export async function resolveConnectorSubject(userId: number, workspaceId: string | null, issuedAt?: Date): Promise<ConnectorSubject> {
  const user = await getUserById(userId);
  if (!user) throw new AppError("NOT_FOUND");
  if (user.accountStatus === "SUSPENDED") throw new AppError("ACCOUNT_SUSPENDED");
  if (issuedAt && user.sessionsValidAfter && issuedAt.getTime() < user.sessionsValidAfter.getTime()) throw new AppError("OAUTH_GRANT_REVOKED");
  const workspace = await resolveWorkspace(user.id, workspaceId);
  if (!workspace) throw new AppError("NO_WORKSPACE");
  await assertMcpEntitled(user.id);
  return { user, workspace };
}

// ---------------------------------------------------------------------------
// Dynamic Client Registration (RFC 7591)
// ---------------------------------------------------------------------------

const registrationSchema = z.object({
  redirect_uris: z.array(z.string().max(512)).min(1).max(10),
  client_name: z.string().max(200).optional(),
  token_endpoint_auth_method: z.string().max(64).optional(),
  grant_types: z.array(z.string().max(64)).max(5).optional(),
  response_types: z.array(z.string().max(64)).max(5).optional(),
  scope: z.string().max(500).optional(),
});

export const registerClient = handle(async (req, res) => {
  throttle(req, "oauthRegister", ipKey(req), 20, 60 * MINUTE);
  const parsed = registrationSchema.safeParse(req.body ?? {});
  if (!parsed.success) throw new OAuthFailure("invalid_client_metadata", "redirect_uris is required and every field must be well-formed");
  const meta = parsed.data;
  const bad = meta.redirect_uris.find((u) => !isAllowedRedirectUri(u));
  if (bad) throw new OAuthFailure("invalid_redirect_uri", `Redirect URI not allowed: ${bad.slice(0, 200)}`);
  const authMethod = meta.token_endpoint_auth_method ?? "client_secret_basic";
  if (!(AUTH_METHODS as readonly string[]).includes(authMethod)) throw new OAuthFailure("invalid_client_metadata", `Unsupported token_endpoint_auth_method: ${authMethod}`);
  const grantTypes = meta.grant_types ?? ["authorization_code", "refresh_token"];
  if (!grantTypes.every((g) => g === "authorization_code" || g === "refresh_token")) throw new OAuthFailure("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported");
  const responseTypes = meta.response_types ?? ["code"];
  if (!responseTypes.every((r) => r === "code")) throw new OAuthFailure("invalid_client_metadata", "Only the code response type is supported");
  if (meta.scope !== undefined && parseScopes(meta.scope) === null) throw new OAuthFailure("invalid_client_metadata", "Unknown scope");

  const clientId = `rsl_${nanoid(24)}`;
  const secret = authMethod === "none" ? null : newSecret("rsls_");
  const name = (meta.client_name?.trim() || "MCP client").slice(0, 120);
  await oauthStore().createClient({ id: clientId, secretHash: secret ? sha256(secret) : null, name, redirectUris: meta.redirect_uris, authMethod });
  res.set("Cache-Control", "no-store");
  res.status(201).json({
    client_id: clientId,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: meta.redirect_uris,
    grant_types: grantTypes,
    response_types: responseTypes,
    token_endpoint_auth_method: authMethod,
  });
});

// ---------------------------------------------------------------------------
// Authorization endpoint
// ---------------------------------------------------------------------------

function errorRedirect(redirectUri: string, error: string, description: string, state?: string) {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return url.href;
}

/**
 * Validates the request, stores it as a pending authorization request and sends the browser to the
 * consent page on the frontend, where the teacher signs in with their Resulio session and approves.
 * Problems with client_id or redirect_uri are shown here; every later problem goes back to the client.
 */
export const authorize = handle(async (req, res) => {
  throttle(req, "oauthAuthorize", ipKey(req), 60, 15 * MINUTE);
  res.set("Cache-Control", "no-store");
  const q = (req.method === "POST" ? req.body : req.query) as Record<string, unknown>;
  const clientId = str(q.client_id, 64);
  const client = clientId ? await oauthStore().getClient(clientId) : null;
  if (!client) throw new OAuthFailure("invalid_client", "Unknown client_id");
  let redirectUri = str(q.redirect_uri, 512);
  if (redirectUri) {
    if (!client.redirectUris.some((r) => redirectUriMatches(redirectUri!, r))) throw new OAuthFailure("invalid_request", "redirect_uri is not registered for this client");
  } else if (client.redirectUris.length === 1) {
    redirectUri = client.redirectUris[0];
  } else {
    throw new OAuthFailure("invalid_request", "redirect_uri is required");
  }
  if (!isAllowedRedirectUri(redirectUri)) throw new OAuthFailure("invalid_request", "redirect_uri is not allowed");

  const state = str(q.state, 1024);
  const fail = (error: string, description: string) => res.redirect(302, errorRedirect(redirectUri!, error, description, state));
  if (q.response_type !== "code") return fail("unsupported_response_type", "response_type must be code");
  const challenge = str(q.code_challenge, 128);
  if (!challenge || !PKCE_CHALLENGE_PATTERN.test(challenge)) return fail("invalid_request", "code_challenge is required (PKCE)");
  if (q.code_challenge_method !== "S256") return fail("invalid_request", "code_challenge_method must be S256");
  const scopes = parseScopes(str(q.scope, 500));
  if (!scopes) return fail("invalid_scope", "Unknown scope");
  const base = apiBaseUrl(req);
  const resource = str(q.resource, 255) ?? mcpResourceUrl(base);
  if (!sameResource(resource, mcpResourceUrl(base))) return fail("invalid_target", "Unknown resource");

  const id = nanoid(32);
  await oauthStore().createRequest({
    id,
    clientId: client.id,
    redirectUri,
    codeChallenge: challenge,
    scopes: scopeString(scopes),
    resource: mcpResourceUrl(base),
    state: state ?? null,
    expiresAt: new Date(Date.now() + AUTH_REQUEST_TTL_MS),
  });
  res.redirect(302, consentPageUrl(base, id));
});

// ---------------------------------------------------------------------------
// Consent (called from the frontend through tRPC, with the teacher's session)
// ---------------------------------------------------------------------------

async function pendingRequest(requestId: string, now = new Date()) {
  const request = await oauthStore().getRequest(requestId);
  if (!request || request.approvedAt || request.usedAt || request.expiresAt <= now) throw new AppError("OAUTH_REQUEST_INVALID");
  const client = await oauthStore().getClient(request.clientId);
  if (!client) throw new AppError("OAUTH_REQUEST_INVALID");
  return { request, client };
}

/** What the consent page shows: the client, the requested scopes and whether this account may approve. */
export async function consentDetails(user: User, requestId: string) {
  const { request, client } = await pendingRequest(requestId);
  const [workspaces, entitlement] = await Promise.all([managedWorkspaces(user.id), mcpEntitlement(user.id)]);
  return {
    clientName: client.name,
    redirectHost: new URL(request.redirectUri).host,
    scopes: request.scopes.split(" ").filter(Boolean) as McpScope[],
    workspaces: workspaces.map((w) => ({ id: w.id, title: w.title })),
    isTeacher: workspaces.length > 0,
    entitlement,
    expiresAt: request.expiresAt,
  };
}

/** Approves: binds a short-lived, single-use code to the user, workspace, client, redirect URI and PKCE challenge. */
export async function approveConsent(user: User, requestId: string, workspaceId: string | null) {
  const { request, client } = await pendingRequest(requestId);
  const { workspace } = await resolveConnectorSubject(user.id, workspaceId);
  const code = newSecret("rslc_");
  const now = new Date();
  const ok = await oauthStore().approveRequest(request.id, { userId: user.id, workspaceId: workspace.id, codeHash: sha256(code), expiresAt: new Date(now.getTime() + AUTH_CODE_TTL_MS) }, now);
  if (!ok) throw new AppError("OAUTH_REQUEST_INVALID");
  await recordMcpAudit({ userId: user.id, workspaceId: workspace.id, clientId: client.id, tool: "oauth:approve", args: { client: client.name, scopes: request.scopes }, status: "OK", errorCode: null, durationMs: null });
  const url = new URL(request.redirectUri);
  url.searchParams.set("code", code);
  if (request.state) url.searchParams.set("state", request.state);
  return { redirectTo: url.href };
}

export async function denyConsent(user: User, requestId: string) {
  const { request, client } = await pendingRequest(requestId);
  await oauthStore().closeRequest(request.id, new Date());
  await recordMcpAudit({ userId: user.id, workspaceId: null, clientId: client.id, tool: "oauth:deny", args: { client: client.name }, status: "OK", errorCode: null, durationMs: null });
  return { redirectTo: errorRedirect(request.redirectUri, "access_denied", "The teacher declined the request", request.state ?? undefined) };
}

// ---------------------------------------------------------------------------
// Token endpoint
// ---------------------------------------------------------------------------

async function issueTokens(grant: { clientId: string; userId: number; workspaceId: string; scopes: string; resource: string; familyId: string }) {
  const now = Date.now();
  const accessToken = newSecret("rsl_at_");
  const refreshToken = newSecret("rsl_rt_");
  const rows: NewToken[] = [
    { id: nanoid(), tokenHash: sha256(accessToken), kind: "ACCESS", ...grant, expiresAt: new Date(now + ACCESS_TOKEN_TTL_MS) },
    { id: nanoid(), tokenHash: sha256(refreshToken), kind: "REFRESH", ...grant, expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS) },
  ];
  await oauthStore().insertTokens(rows);
  return { access_token: accessToken, token_type: "Bearer", expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000), refresh_token: refreshToken, scope: grant.scopes };
}

async function subjectOrDeny(userId: number, workspaceId: string, issuedAt?: Date) {
  try {
    await resolveConnectorSubject(userId, workspaceId, issuedAt);
  } catch (error) {
    const code = error instanceof AppError ? error.code : "ERROR";
    throw new OAuthFailure("invalid_grant", `The Resulio account can no longer use the connector (${code})`);
  }
}

async function exchangeCode(client: OAuthClientRow, body: Record<string, unknown>, base: string) {
  const code = str(body.code, 256);
  const verifier = str(body.code_verifier, 128);
  if (!code || !verifier) throw new OAuthFailure("invalid_request", "code and code_verifier are required");
  const store = oauthStore();
  const row = await store.getCodeByHash(sha256(code));
  const now = new Date();
  if (!row || row.clientId !== client.id || !row.approvedAt || !row.userId || !row.workspaceId) throw new OAuthFailure("invalid_grant", "Invalid authorization code");
  if (row.usedAt) {
    // A replayed code may mean it leaked: everything issued from it is revoked (OAuth 2.1 §4.1.3).
    await store.revokeFamily(row.id, now);
    throw new OAuthFailure("invalid_grant", "Authorization code already used");
  }
  if (row.expiresAt <= now) throw new OAuthFailure("invalid_grant", "Authorization code expired");
  const redirectUri = str(body.redirect_uri, 512);
  if (redirectUri !== undefined && redirectUri !== row.redirectUri) throw new OAuthFailure("invalid_grant", "redirect_uri does not match the authorization request");
  const resource = str(body.resource, 255);
  if (resource !== undefined && !sameResource(resource, mcpResourceUrl(base))) throw new OAuthFailure("invalid_target", "Unknown resource");
  if (!(await store.consumeCode(row.id, now))) throw new OAuthFailure("invalid_grant", "Authorization code already used");
  if (!pkceMatches(verifier, row.codeChallenge)) throw new OAuthFailure("invalid_grant", "code_verifier does not match the code_challenge");
  await subjectOrDeny(row.userId, row.workspaceId);
  return issueTokens({ clientId: client.id, userId: row.userId, workspaceId: row.workspaceId, scopes: row.scopes, resource: row.resource, familyId: row.id });
}

async function exchangeRefresh(client: OAuthClientRow, body: Record<string, unknown>, base: string) {
  const token = str(body.refresh_token, 256);
  if (!token) throw new OAuthFailure("invalid_request", "refresh_token is required");
  const store = oauthStore();
  const row = await store.getTokenByHash(sha256(token));
  const now = new Date();
  if (!row || row.kind !== "REFRESH" || row.clientId !== client.id) throw new OAuthFailure("invalid_grant", "Invalid refresh token");
  if (row.revokedAt) {
    // Refresh tokens rotate on every use; seeing an old one again means it was copied, so the whole grant ends.
    await store.revokeFamily(row.familyId, now);
    throw new OAuthFailure("invalid_grant", "Refresh token already used or revoked");
  }
  if (row.expiresAt <= now) throw new OAuthFailure("invalid_grant", "Refresh token expired");
  const resource = str(body.resource, 255);
  if (resource !== undefined && !sameResource(resource, mcpResourceUrl(base))) throw new OAuthFailure("invalid_target", "Unknown resource");
  let scopes = row.scopes;
  const requested = str(body.scope, 500);
  if (requested !== undefined) {
    const parsed = parseScopes(requested);
    const granted = row.scopes.split(" ");
    if (!parsed || !parsed.every((s) => granted.includes(s))) throw new OAuthFailure("invalid_scope", "Scope exceeds the original grant");
    scopes = scopeString(parsed);
  }
  if (!(await store.revokeToken(row.id, now))) {
    await store.revokeFamily(row.familyId, now);
    throw new OAuthFailure("invalid_grant", "Refresh token already used or revoked");
  }
  await subjectOrDeny(row.userId, row.workspaceId, row.createdAt);
  return issueTokens({ clientId: client.id, userId: row.userId, workspaceId: row.workspaceId, scopes, resource: row.resource, familyId: row.familyId });
}

export const token = handle(async (req, res) => {
  throttle(req, "oauthToken", ipKey(req), 120, 15 * MINUTE);
  const client = await authenticateClient(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const base = apiBaseUrl(req);
  let result;
  if (body.grant_type === "authorization_code") result = await exchangeCode(client, body, base);
  else if (body.grant_type === "refresh_token") result = await exchangeRefresh(client, body, base);
  else throw new OAuthFailure("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");
  res.json(result);
});

// ---------------------------------------------------------------------------
// Revocation (RFC 7009)
// ---------------------------------------------------------------------------

/** Revoking a refresh token ends the whole grant; an access token only itself. Unknown tokens still get 200. */
export const revoke = handle(async (req, res) => {
  throttle(req, "oauthRevoke", ipKey(req), 60, 15 * MINUTE);
  const client = await authenticateClient(req);
  const body = (req.body ?? {}) as Record<string, unknown>;
  const value = str(body.token, 256);
  if (!value) throw new OAuthFailure("invalid_request", "token is required");
  const row = await oauthStore().getTokenByHash(sha256(value));
  if (row && row.clientId === client.id) {
    const now = new Date();
    if (row.kind === "REFRESH") await oauthStore().revokeFamily(row.familyId, now);
    else await oauthStore().revokeToken(row.id, now);
    await recordMcpAudit({ userId: row.userId, workspaceId: row.workspaceId, clientId: client.id, tool: "oauth:revoke", args: { kind: row.kind }, status: "OK", errorCode: null, durationMs: null });
  }
  res.set("Cache-Control", "no-store");
  res.status(200).json({});
});

// ---------------------------------------------------------------------------
// Resource server: access token verification
// ---------------------------------------------------------------------------

/** The live access token for this value and resource, or null (unknown, wrong kind, revoked, expired, other resource). */
export async function findAccessToken(value: string, base: string, now = new Date()): Promise<OAuthTokenRow | null> {
  const row = await oauthStore().getTokenByHash(sha256(value));
  if (!row || row.kind !== "ACCESS" || row.revokedAt || row.expiresAt <= now) return null;
  if (!sameResource(row.resource, mcpResourceUrl(base))) return null;
  return row;
}

/** Teacher-initiated disconnect from the settings page: ends every grant of this client for this user. */
export async function revokeConnection(user: User, clientId: string) {
  const count = await oauthStore().revokeUserClient(user.id, clientId, new Date());
  await recordMcpAudit({ userId: user.id, workspaceId: null, clientId, tool: "oauth:disconnect", args: null, status: "OK", errorCode: null, durationMs: null });
  return { revoked: count };
}
