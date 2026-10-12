# Claude connector (remote MCP server)

Teachers connect Resulio to Claude as a custom connector. After they sign in to Resulio and approve, Claude can create draft exams, send exams and tasks to groups or individual students, and read results, always as that teacher and only inside their own workspace.

**Connector URL (production):** `https://api.resulio.co/mcp`

## How it fits together

- `server/mcp/http.ts`: routes, CORS, bearer-token check and the stateless Streamable HTTP endpoint (official `@modelcontextprotocol/sdk`, a fresh `McpServer` and transport per POST, so any instance can answer any request).
- `server/mcp/oauth.ts`: OAuth 2.1 authorization server (metadata, dynamic client registration, authorize, token, revoke) and the consent logic.
- `server/mcp/tools.ts`: the MCP tools. Each calls the existing services (`modules/assessments`, `modules/tasks`, `modules/groups`, `modules/attempts`, `modules/activity`, `questionBank/bank`) with a teacher scope resolved exactly as `teacherProcedure` does (`resolveWorkspace`, ownership checks inside the services).
- `server/mcp/entitlement.ts`: the per-teacher subscription and upgrade requests.
- `server/mcp/router.ts`: tRPC `mcpConnector.*` for the settings panel and the consent page.
- Frontend: `/connect/claude` (consent, `client/src/pages/ClaudeConnector.tsx`), Settings → Claude inteqrasiyası (`client/src/components/ClaudeConnectorPanel.tsx`), Admin → Müəllim limitləri (subscriptions and requests).

### Why not the SDK's `mcpAuthRouter`

The SDK auth router mounts fixed paths at the app root, compares client secrets in plain text and pulls in Express 5 and `express-rate-limit`. Resulio runs Express 4, stores only hashes and already has its own rate limiter and security events, so the OAuth endpoints are implemented here (about 450 lines) and the SDK is used for the MCP protocol itself.

## Endpoints (on the API host)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` | Protected Resource Metadata (RFC 9728) |
| GET | `/.well-known/oauth-authorization-server` (also `/mcp` suffix) | Authorization Server Metadata (RFC 8414) |
| POST | `/oauth/register` | Dynamic Client Registration (RFC 7591) |
| GET/POST | `/oauth/authorize` | Authorization code + PKCE (S256 only); redirects to the consent page |
| POST | `/oauth/token` | `authorization_code` and `refresh_token` (rotation; reuse revokes the grant) |
| POST | `/oauth/revoke` | Token revocation (RFC 7009); a refresh token ends the whole grant |
| POST | `/mcp` | MCP Streamable HTTP (JSON responses). GET/DELETE return 405 (stateless server) |

Unauthenticated `/mcp` requests get `401` with `WWW-Authenticate: Bearer resource_metadata="<API>/.well-known/oauth-protected-resource/mcp"`. These paths answer CORS for any origin without credentials; the cookie-based `/api/` keeps its own CORS and CSRF rules.

Redirect URIs: only `https://claude.ai/api/mcp/auth_callback` and `https://claude.com/api/mcp/auth_callback`, plus loopback (`http://localhost|127.0.0.1|[::1]:<any port>`) when `MCP_ALLOW_LOOPBACK_REDIRECTS` is on, plus `MCP_EXTRA_REDIRECT_URIS`. Everything else is refused at registration and at authorization.

## Security model

- The connector URL is not a secret and does not need to be: Claude Pro/Max users paste it themselves. The settings panel does not display it (the button copies it and opens Claude's prefilled dialog), but the protection is OAuth plus the server-side checks below, not URL secrecy.
- Codes, access tokens, refresh tokens and client secrets are stored only as SHA-256 hashes. Access tokens last 1 hour, refresh tokens 30 days; authorization codes 2 minutes and single use, bound to user, workspace, client, redirect URI and PKCE challenge. A replayed code or reused refresh token revokes everything issued from that consent.
- On consent, at token issuance, at refresh **and on every MCP request** the server re-checks: account exists and is not suspended, the grant is newer than the user's `sessionsValidAfter` (sign out everywhere), the teacher still owns the bound workspace, and the subscription is active. A lapsed or revoked subscription gets `403` with a readable message on the very next call.
- "Teacher" means owning a workspace, the same test as `teacherProcedure`; students have none and are refused.
- Rate limits: 120 MCP requests/minute per token, 60 write tool calls/hour per teacher, per-IP limits on the OAuth endpoints (in memory, per instance; blocks are recorded as `RATE_LIMIT_BLOCK` security events).
- Every tool call is written to `mcp_audit_log` (user, workspace, client, tool, summarised arguments without question text, status `OK | ERROR | DENIED | PREVIEW`, error code, duration), as are consents, denials, disconnects and revocations.
- No delete tools exist. Sending to students requires `confirm: true`; with `confirm: false` the tool returns a preview and changes nothing.

## Scopes and tools

| Scope | Meaning |
| --- | --- |
| `exams:read` | See exams and tasks |
| `exams:write` | Create draft exams |
| `groups:read` | See groups and student names |
| `assignments:send` | Send exams and tasks to groups or students |
| `results:read` | Read results |

| Tool | Scope | Notes |
| --- | --- | --- |
| `list_groups` | groups:read | ids, names, student counts |
| `list_students` | groups:read | the teacher's students (optionally one group) |
| `list_exams` | exams:read or exams:write | status DRAFT/SCHEDULED/ACTIVE/COMPLETED, window, edit link |
| `list_tasks` | exams:read or assignments:send | deadline, recipients, submission counts |
| `create_exam` | exams:write | title, description, duration, window, questions (`shared/assessment.ts` schema); created as a draft students cannot see; questions are filed in the question bank; returns an edit link |
| `send_assignment` | assignments:send | `kind: exam|task`, `group_ids` and/or `student_ids` (only the teacher's own students), optional exam window; publishes a never-published exam; requires `confirm: true` |
| `get_results` | results:read | `exam_id` (per-student status and scores) or `student_id` (all results of one student) |

## Subscription (entitlement)

Table `mcp_entitlements` (one row per teacher): `enabled`, `plan`, `expiresAt` (null = no end date), `grantedBy`, `note`. Active means `enabled` and not past `expiresAt`.

- **Demo teacher:** migration `0059_mcp_connector` inserts an active `demo` plan with no end date for `telmanabdulladev@gmail.com` (`INSERT IGNORE … SELECT … FROM users WHERE email = …`). It is a no-op when that account does not exist; since migrations run once, grant it from the admin panel if the account is created later.
- **Other teachers:** Admin → Müəllim limitləri → a teacher's "Claude inteqrasiyası" line → İdarə et: choose a plan, an end date (or none) and a note → Aktivləşdir / uzat; Deaktiv et revokes at once. Needs the `ai.manage` admin permission; changes are written to the admin audit log (`MCP_ENTITLEMENT_CHANGED`).
- **Upgrade requests:** there is no payment system yet. A teacher without an active subscription sees "Premium AI inteqrasiyası" with an "Abunə ol" button; it creates one open request per teacher (`mcp_upgrade_requests`, idempotent), shows "Sorğunuz göndərildi…" and sends an in-app notification to admins who hold `ai.manage`. Open requests are listed at the top of Admin → Müəllim limitləri; granting closes the request.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `PUBLIC_API_URL` | request origin (proxy aware) | Public origin of the API, used as OAuth issuer and resource. **Set to `https://api.resulio.co` on Railway.** |
| `FRONTEND_URL` | (existing) | Where the consent page lives (`https://resulio.co`) |
| `MCP_ALLOW_LOOPBACK_REDIRECTS` | on outside production | Allow `http://localhost` / `127.0.0.1` redirect URIs (MCP Inspector, local clients) |
| `MCP_EXTRA_REDIRECT_URIS` | empty | Comma-separated extra exact redirect URIs |

## Connecting from Claude

### Individual plans (Free, Pro, Max)

1. Resulio → Parametrlər → Claude inteqrasiyası → **Claude-a qoşul**. This copies the connector URL and opens Claude's "Add custom connector" dialog with name and URL prefilled (`https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Resulio&connectorUrl=…`).
2. If the URL field is empty, paste (Ctrl/Cmd+V). Manual path: Claude → Customize → Connectors → Add → Custom → Web → paste `https://api.resulio.co/mcp`.
3. Connect, sign in to Resulio, review the permissions and approve. If Claude asks how to identify itself, choose automatic registration.

Free Claude plans allow one custom connector.

### Claude Team and Enterprise

An organization Owner adds the connector once for everyone: Claude → Organization settings → Connectors → Add → Custom → Web → `https://api.resulio.co/mcp` (or the prefilled admin link `https://claude.ai/admin-settings/connectors?modal=add-custom-connector&connectorName=Resulio&connectorUrl=https%3A%2F%2Fapi.resulio.co%2Fmcp`). It then appears for members under Customize → Connectors. Each teacher only clicks **Connect** and signs in with their **own** Resulio account; tokens, permissions and the subscription check are per teacher, so one teacher never sees another's data, and teachers without an active subscription are refused at consent.

## Testing

- Unit: `pnpm test` includes `server/mcpConnector.test.ts` (redirect allowlist, PKCE, scopes, entitlement states, audit summaries, metadata, 401 challenge, CORS).
- Integration (real MySQL): `TEST_DATABASE_URL=mysql://… pnpm test:db` runs `server/integration/mcpConnector.it.ts`: the full flow through a real HTTP server with the SDK MCP client (DCR → authorize with PKCE → consent → token → initialize → tools/list → tool calls → refresh → revoke), wrong PKCE, wrong redirect URI, expired and reused codes, refresh-token reuse, teacher without subscription, student, expired subscription blocking an existing token and its refresh, admin revocation, per-tool scopes, individual-student and cross-teacher ownership, idempotent upgrade requests, the demo seed, and audit rows.
- Manually: `npx @modelcontextprotocol/inspector`, transport "Streamable HTTP", URL `http://localhost:3000/mcp`; the Inspector runs the OAuth flow against the local server (loopback redirects are allowed outside production).

## Limitations

- Claude identifies itself through dynamic client registration; Client ID Metadata Documents ("published identity") are not supported yet.
- Rate limits are in memory per instance.
- `send_assignment` adds recipients; removing them, deleting and grading are done in the Resulio web app.
- Exams with unpublished draft changes keep serving the published version until the teacher publishes in Resulio; the tool says so in its result.
