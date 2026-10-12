import { bigint, boolean, index, int, json, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

/**
 * Claude connector (remote MCP server + OAuth 2.1 authorization server, docs/MCP-CONNECTOR.md).
 * Side tables only: nothing here is read by the Teacher → Group → Exam model. Codes, tokens and
 * client secrets are stored as SHA-256 hashes, never in the clear. Every constraint and index name
 * stays within MySQL's 64 characters.
 */

export const OAUTH_TOKEN_KINDS = ["ACCESS", "REFRESH"] as const;
export type OAuthTokenKind = (typeof OAUTH_TOKEN_KINDS)[number];

/** Clients registered through Dynamic Client Registration (RFC 7591), e.g. Claude. */
export const oauthClients = mysqlTable("oauth_clients", {
  id: varchar("id", { length: 64 }).primaryKey(),
  /** Null for public clients (`token_endpoint_auth_method: none`). */
  secretHash: varchar("secretHash", { length: 64 }),
  name: varchar("name", { length: 120 }).notNull(),
  redirectUris: json("redirectUris").$type<string[]>().notNull(),
  authMethod: varchar("authMethod", { length: 32 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
});

/**
 * One row per authorization request. It starts pending (no user, no code) while the teacher looks at
 * the consent page; approving binds it to the user and workspace and stores the hash of a short-lived,
 * single-use code bound to the client, redirect URI and PKCE challenge.
 */
export const oauthCodes = mysqlTable(
  "oauth_codes",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    clientId: varchar("clientId", { length: 64 }).notNull(),
    redirectUri: varchar("redirectUri", { length: 512 }).notNull(),
    codeChallenge: varchar("codeChallenge", { length: 128 }).notNull(),
    scopes: varchar("scopes", { length: 255 }).notNull(),
    resource: varchar("resource", { length: 255 }).notNull(),
    state: text("state"),
    userId: int("userId"),
    workspaceId: varchar("workspaceId", { length: 32 }),
    codeHash: varchar("codeHash", { length: 64 }),
    expiresAt: timestamp("expiresAt").notNull(),
    approvedAt: timestamp("approvedAt"),
    usedAt: timestamp("usedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("oauth_codes_codeHash_unique").on(t.codeHash)],
);

/** Access and refresh tokens. A family is one consent: refreshes rotate within it, reuse revokes it. */
export const oauthTokens = mysqlTable(
  "oauth_tokens",
  {
    id: varchar("id", { length: 32 }).primaryKey(),
    tokenHash: varchar("tokenHash", { length: 64 }).notNull(),
    kind: mysqlEnum("kind", OAUTH_TOKEN_KINDS).notNull(),
    clientId: varchar("clientId", { length: 64 }).notNull(),
    userId: int("userId").notNull(),
    workspaceId: varchar("workspaceId", { length: 32 }).notNull(),
    scopes: varchar("scopes", { length: 255 }).notNull(),
    resource: varchar("resource", { length: 255 }).notNull(),
    familyId: varchar("familyId", { length: 32 }).notNull(),
    expiresAt: timestamp("expiresAt").notNull(),
    revokedAt: timestamp("revokedAt"),
    lastUsedAt: timestamp("lastUsedAt"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("oauth_tokens_tokenHash_unique").on(t.tokenHash),
    index("oauth_tokens_user_client_idx").on(t.userId, t.clientId),
    index("oauth_tokens_family_idx").on(t.familyId),
  ],
);

/** Every MCP tool call and connector consent/revocation: who, what (summarised arguments), outcome. */
export const mcpAuditLog = mysqlTable(
  "mcp_audit_log",
  {
    id: bigint("id", { mode: "number" }).autoincrement().primaryKey(),
    userId: int("userId").notNull(),
    workspaceId: varchar("workspaceId", { length: 32 }),
    clientId: varchar("clientId", { length: 64 }),
    tool: varchar("tool", { length: 64 }).notNull(),
    args: json("args").$type<Record<string, unknown>>(),
    status: varchar("status", { length: 16 }).notNull(),
    errorCode: varchar("errorCode", { length: 64 }),
    durationMs: int("durationMs"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("mcp_audit_log_user_idx").on(t.userId, t.createdAt)],
);

/**
 * The connector is a paid feature, granted per teacher like a subscription. Active means enabled and
 * not past expiresAt (null: no end date). Checked at consent, token issuance, refresh and on every
 * MCP request, so a lapsed teacher's tokens stop working at once.
 */
export const mcpEntitlements = mysqlTable("mcp_entitlements", {
  userId: int("userId").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  plan: varchar("plan", { length: 32 }).notNull(),
  expiresAt: timestamp("expiresAt"),
  grantedBy: int("grantedBy"),
  note: varchar("note", { length: 255 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

export const MCP_UPGRADE_STATUSES = ["OPEN", "HANDLED"] as const;
export type McpUpgradeStatus = (typeof MCP_UPGRADE_STATUSES)[number];

/** "Subscribe" requests from teachers (there is no payment system yet); one row per teacher, at most one open. */
export const mcpUpgradeRequests = mysqlTable(
  "mcp_upgrade_requests",
  {
    userId: int("userId").primaryKey(),
    status: mysqlEnum("status", MCP_UPGRADE_STATUSES).notNull(),
    requestedAt: timestamp("requestedAt").notNull(),
    handledAt: timestamp("handledAt"),
    handledBy: int("handledBy"),
    createdAt: timestamp("createdAt").defaultNow().notNull(),
  },
  (t) => [index("mcp_upgrade_requests_status_idx").on(t.status, t.requestedAt)],
);

export type OAuthClientRow = typeof oauthClients.$inferSelect;
export type McpEntitlementRow = typeof mcpEntitlements.$inferSelect;
export type McpUpgradeRequestRow = typeof mcpUpgradeRequests.$inferSelect;
export type OAuthCodeRow = typeof oauthCodes.$inferSelect;
export type OAuthTokenRow = typeof oauthTokens.$inferSelect;
export type McpAuditRow = typeof mcpAuditLog.$inferSelect;
