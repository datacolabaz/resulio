import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Express, NextFunction, Request, Response } from "express";
import { MCP_PATH, type McpScope, isMcpScope } from "../../shared/mcpConnector";
import { hitRateLimit } from "../_core/rateLimit";
import { hashIp } from "../_core/requestMeta";
import { AppError } from "../modules/errors";
import { recordSecurityEvent } from "../modules/securityEvents";
import { recordMcpAudit } from "./audit";
import { apiBaseUrl, protectedResourceMetadataUrl } from "./config";
import { authorizationServerMetadata, authorize, findAccessToken, protectedResourceMetadata, registerClient, resolveConnectorSubject, revoke, token } from "./oauth";
import { oauthStore } from "./store";
import { createMcpServer, type McpContext } from "./tools";

const TOKEN_LIMIT = 120;
const TOKEN_WINDOW_MS = 60_000;
const TOUCH_EVERY_MS = 60_000;

const isConnectorPath = (path: string) => path === MCP_PATH || path.startsWith("/oauth/") || path.startsWith("/.well-known/oauth-");

/**
 * Claude (and MCP Inspector) call these endpoints from other origins without cookies, so they
 * answer any origin with no credentials. They never read the Resulio session cookie, and the
 * cookie-based API keeps its own CORS and CSRF rules under /api/.
 */
function connectorCors(req: Request, res: Response, next: NextFunction) {
  if (!isConnectorPath(req.path)) return next();
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID");
  res.set("Access-Control-Expose-Headers", "Mcp-Session-Id, Mcp-Protocol-Version, WWW-Authenticate");
  res.set("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return void res.status(204).end();
  next();
}

function unauthorized(req: Request, res: Response, error?: { code: string; description: string }) {
  const parts = [`resource_metadata="${protectedResourceMetadataUrl(apiBaseUrl(req))}"`];
  if (error) parts.push(`error="${error.code}"`, `error_description="${error.description}"`);
  res.set("WWW-Authenticate", `Bearer ${parts.join(", ")}`);
  res.status(401).json({ error: error?.code ?? "unauthorized", error_description: error?.description ?? "Sign in to Resulio through the connector to use this server" });
}

type AuthedRequest = Request & { mcp?: McpContext; auth?: { token: string; clientId: string; scopes: string[]; expiresAt?: number } };

const SUBJECT_MESSAGES: Record<string, string> = {
  MCP_NOT_ENABLED: "The Resulio AI integration (Claude connector) is not active for this account. It is part of the premium plan; subscribe in Resulio → Settings.",
  MCP_ENTITLEMENT_EXPIRED: "The Resulio premium AI integration for this account has expired. Renew it in Resulio → Settings to keep using Claude with Resulio.",
  NO_WORKSPACE: "This Resulio account no longer has the teacher workspace this connection was made for",
  ACCOUNT_SUSPENDED: "This Resulio account is suspended",
};

/** Express 4 does not catch rejected promises from middleware. */
function bearer(req: AuthedRequest, res: Response, next: NextFunction) {
  authenticate(req, res, next).catch((error) => {
    console.error("[MCP] token check failed", error instanceof Error ? error.message : error);
    if (!res.headersSent) res.status(503).json({ error: "temporarily_unavailable", error_description: "Try again shortly" });
  });
}

/** Resolves the bearer token to a teacher scope with the same checks as teacherProcedure, re-run on every request. */
async function authenticate(req: AuthedRequest, res: Response, next: NextFunction) {
  const header = req.get("authorization") ?? "";
  if (!header.toLowerCase().startsWith("bearer ")) return unauthorized(req, res);
  const value = header.slice(7).trim();
  const base = apiBaseUrl(req);
  const row = value.length <= 256 ? await findAccessToken(value, base) : null;
  if (!row) return unauthorized(req, res, { code: "invalid_token", description: "The access token is invalid or expired" });
  if (hitRateLimit(`mcp:t:${row.id}`, TOKEN_LIMIT, TOKEN_WINDOW_MS)) {
    recordSecurityEvent({ type: "RATE_LIMIT_BLOCK", severity: "LOW", userId: row.userId, ipHash: hashIp(req.ip), details: { limiter: "mcpToken" } });
    res.set("Retry-After", "60");
    return void res.status(429).json({ error: "rate_limited", error_description: "Too many requests; slow down" });
  }
  let subject;
  try {
    subject = await resolveConnectorSubject(row.userId, row.workspaceId, row.createdAt);
  } catch (error) {
    const code = error instanceof AppError ? error.code : "ERROR";
    await recordMcpAudit({ userId: row.userId, workspaceId: row.workspaceId, clientId: row.clientId, tool: "mcp:request", args: null, status: "DENIED", errorCode: code, durationMs: null });
    if (code === "OAUTH_GRANT_REVOKED" || code === "NOT_FOUND") return unauthorized(req, res, { code: "invalid_token", description: "The connection was revoked; connect again" });
    // Not `insufficient_scope`: that asks clients to re-authorize, which cannot help until an admin renews the plan.
    const message = SUBJECT_MESSAGES[code] ?? "This Resulio account cannot use the connector";
    const id = req.body && typeof req.body === "object" && "id" in req.body ? (req.body as { id: unknown }).id : null;
    return void res.status(403).json({ jsonrpc: "2.0", id: id ?? null, error: { code: -32001, message, data: { reason: code } }, error_description: message });
  }
  const now = Date.now();
  if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > TOUCH_EVERY_MS) {
    oauthStore()
      .touchToken(row.id, new Date(now))
      .catch(() => undefined);
  }
  const scopes = row.scopes.split(" ").filter(isMcpScope) as McpScope[];
  req.auth = { token: value, clientId: row.clientId, scopes, expiresAt: Math.floor(row.expiresAt.getTime() / 1000) };
  req.mcp = { user: subject.user, workspace: subject.workspace, scope: { workspaceId: subject.workspace.id, userId: subject.user.id }, scopes, clientId: row.clientId, base };
  next();
}

/** Stateless Streamable HTTP: a fresh server and transport per POST, so any instance can answer any request. */
async function handleMcp(req: AuthedRequest, res: Response) {
  const server = createMcpServer(req.mcp!);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req as never, res, req.body);
  } catch (error) {
    console.error("[MCP] request failed", error instanceof Error ? error.message : error);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
}

function methodNotAllowed(_req: Request, res: Response) {
  res.set("Allow", "POST");
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless, use POST" }, id: null });
}

export function registerMcpRoutes(app: Express) {
  app.use(connectorCors);

  const resourceMetadata = (req: Request, res: Response) => {
    res.set("Cache-Control", "public, max-age=300");
    res.json(protectedResourceMetadata(apiBaseUrl(req)));
  };
  const serverMetadata = (req: Request, res: Response) => {
    res.set("Cache-Control", "public, max-age=300");
    res.json(authorizationServerMetadata(apiBaseUrl(req)));
  };
  app.get("/.well-known/oauth-protected-resource", resourceMetadata);
  app.get(`/.well-known/oauth-protected-resource${MCP_PATH}`, resourceMetadata);
  app.get("/.well-known/oauth-authorization-server", serverMetadata);
  app.get(`/.well-known/oauth-authorization-server${MCP_PATH}`, serverMetadata);

  app.post("/oauth/register", registerClient);
  app.get("/oauth/authorize", authorize);
  app.post("/oauth/authorize", authorize);
  app.post("/oauth/token", token);
  app.post("/oauth/revoke", revoke);

  app.post(MCP_PATH, bearer, handleMcp);
  app.get(MCP_PATH, bearer, methodNotAllowed);
  app.delete(MCP_PATH, bearer, methodNotAllowed);
}

/** Expired codes, pending requests and tokens are deleted a while after they stop working. */
export const OAUTH_RETENTION_MS = 7 * 24 * 60 * 60_000;
