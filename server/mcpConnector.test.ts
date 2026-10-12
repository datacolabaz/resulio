import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { claudeInstallUrl, entitlementState, MCP_SCOPES } from "../shared/mcpConnector";
import { summarizeArgs } from "./mcp/audit";
import { isAllowedRedirectUri, parseScopes, pkceMatches, redirectUriMatches, sameResource } from "./mcp/config";
import { registerMcpRoutes } from "./mcp/http";
import { setOAuthStore, type OAuthStore } from "./mcp/store";

describe("Claude connector helpers", () => {
  it("allows only Claude's callbacks and loopback (outside production) as redirect URIs", () => {
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://claude.com/api/mcp/auth_callback")).toBe(true);
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/other")).toBe(false);
    expect(isAllowedRedirectUri("https://evil.example/api/mcp/auth_callback")).toBe(false);
    expect(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback#x")).toBe(false);
    expect(isAllowedRedirectUri("http://127.0.0.1:6274/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("not a url")).toBe(false);
  });

  it("matches loopback redirect URIs on any port and everything else exactly", () => {
    expect(redirectUriMatches("http://127.0.0.1:5000/cb", "http://127.0.0.1:6000/cb")).toBe(true);
    expect(redirectUriMatches("http://127.0.0.1:5000/other", "http://127.0.0.1:6000/cb")).toBe(false);
    expect(redirectUriMatches("https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback")).toBe(false);
  });

  it("verifies PKCE S256 with the RFC 7636 example", () => {
    expect(pkceMatches("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(true);
    expect(pkceMatches("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXX", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(false);
    expect(pkceMatches("short", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")).toBe(false);
  });

  it("parses scopes: empty means all, unknown is refused", () => {
    expect(parseScopes(undefined)).toEqual([...MCP_SCOPES]);
    expect(parseScopes("results:read exams:read")).toEqual(["exams:read", "results:read"]);
    expect(parseScopes("results:read admin")).toBeNull();
  });

  it("compares resource indicators without a trailing slash or fragment", () => {
    expect(sameResource("https://api.resulio.co/mcp/", "https://api.resulio.co/mcp")).toBe(true);
    expect(sameResource("https://api.resulio.co/mcp#a", "https://api.resulio.co/mcp")).toBe(true);
    expect(sameResource("https://other.example/mcp", "https://api.resulio.co/mcp")).toBe(false);
  });

  it("treats an entitlement as active only while enabled and before its end", () => {
    const now = new Date("2026-10-13T12:00:00Z");
    expect(entitlementState(null, now).status).toBe("NONE");
    expect(entitlementState({ enabled: false, plan: "premium", expiresAt: null }, now).status).toBe("DISABLED");
    expect(entitlementState({ enabled: true, plan: "premium", expiresAt: new Date("2026-10-13T11:59:59Z") }, now).status).toBe("EXPIRED");
    expect(entitlementState({ enabled: true, plan: "premium", expiresAt: new Date("2026-10-14T00:00:00Z") }, now).status).toBe("ACTIVE");
    expect(entitlementState({ enabled: true, plan: "demo", expiresAt: null }, now)).toEqual({ status: "ACTIVE", plan: "demo", expiresAt: null });
  });

  it("summarises tool arguments without question content", () => {
    const summary = summarizeArgs({ title: "x".repeat(300), questions: [{ text: "secret" }], group_ids: ["g1"], confirm: true, settings: { a: 1 } });
    expect(summary).toEqual({ title: `${"x".repeat(120)}…`, questions: { count: 1 }, group_ids: ["g1"], confirm: true, settings: "[object]" });
  });

  it("builds Claude's prefilled install link", () => {
    const url = new URL(claudeInstallUrl("https://api.resulio.co/mcp"));
    expect(url.origin + url.pathname).toBe("https://claude.ai/customize/connectors");
    expect(url.searchParams.get("modal")).toBe("add-custom-connector");
    expect(url.searchParams.get("connectorName")).toBe("Resulio");
    expect(url.searchParams.get("connectorUrl")).toBe("https://api.resulio.co/mcp");
  });
});

describe("Claude connector HTTP surface", () => {
  let server: Server;
  let base = "";

  beforeAll(async () => {
    setOAuthStore({ getTokenByHash: async () => null } as unknown as OAuthStore);
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    registerMcpRoutes(app);
    server = app.listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    setOAuthStore(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("publishes protected resource and authorization server metadata", async () => {
    const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: [...MCP_SCOPES] });
    const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("challenges unauthenticated MCP requests with the resource metadata URL", async () => {
    const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const bad = await fetch(`${base}/mcp`, { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("answers CORS preflights for Claude without credentials", async () => {
    const res = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { origin: "https://claude.ai", "access-control-request-method": "POST" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("refuses client registration with a redirect URI outside the allowlist", async () => {
    const res = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://evil.example/callback"], client_name: "Evil" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_redirect_uri");
  });
});
