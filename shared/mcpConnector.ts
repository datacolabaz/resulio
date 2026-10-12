/** Claude connector (remote MCP server). See docs/MCP-CONNECTOR.md. */

/** Path of the MCP endpoint on the API host; the connector URL is `<API origin>/mcp`. */
export const MCP_PATH = "/mcp";

/** Frontend page the authorization endpoint sends the teacher to for login and consent. */
export const MCP_CONSENT_PATH = "/connect/claude";

/** Claude's connector settings (Customize → Connectors); the older /settings/connectors only links here. */
export const CLAUDE_CONNECTORS_URL = "https://claude.ai/customize/connectors";

/** Claude's documented install link: opens "Add custom connector" with the name and URL prefilled for review. */
export function claudeInstallUrl(connectorUrl: string, name = "Resulio"): string {
  const params = new URLSearchParams({ modal: "add-custom-connector", connectorName: name, connectorUrl });
  return `${CLAUDE_CONNECTORS_URL}?${params.toString()}`;
}

export const MCP_SCOPES = ["exams:read", "exams:write", "groups:read", "assignments:send", "results:read"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

export const isMcpScope = (value: string): value is McpScope => (MCP_SCOPES as readonly string[]).includes(value);

/** NONE: never granted; DISABLED: revoked by an admin; EXPIRED: past its end date. */
export const MCP_ENTITLEMENT_STATUSES = ["ACTIVE", "EXPIRED", "DISABLED", "NONE"] as const;
export type McpEntitlementStatus = (typeof MCP_ENTITLEMENT_STATUSES)[number];

export type McpEntitlementState = { status: McpEntitlementStatus; plan: string | null; expiresAt: Date | null };

/** Active means enabled and not past expiresAt (null: no end date). */
export function entitlementState(row: { enabled: boolean; plan: string; expiresAt: Date | null } | null | undefined, now = new Date()): McpEntitlementState {
  if (!row) return { status: "NONE", plan: null, expiresAt: null };
  const status = !row.enabled ? "DISABLED" : row.expiresAt && row.expiresAt.getTime() <= now.getTime() ? "EXPIRED" : "ACTIVE";
  return { status, plan: row.plan, expiresAt: row.expiresAt };
}
