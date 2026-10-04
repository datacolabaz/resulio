/**
 * Platform administration roles and permissions. The server is the only authority; the client
 * uses the same map only to hide controls the server would refuse anyway.
 */

export const ADMIN_ROLES = ["SUPER_ADMIN", "SUPPORT_ADMIN", "PARTNER_ADMIN", "FINANCE_ADMIN", "CONTENT_REVIEWER"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

export const ADMIN_PERMISSIONS = [
  "overview.view",
  "users.search",
  "users.view",
  "users.suspend",
  "users.revokeSessions",
  "workspaces.view",
  "partners.view",
  "partners.decide",
  "flags.view",
  "flags.change",
  "audit.view",
  "audit.viewSupport",
  "security.view",
  "security.review",
  "roles.manage",
  "settings.view",
  "system.notify",
  "syllabus.view",
  "syllabus.override",
] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

const SUPPORT_PERMISSIONS: readonly AdminPermission[] = [
  "overview.view",
  "users.search",
  "users.view",
  "workspaces.view",
  "partners.view",
  "flags.view",
  "audit.viewSupport",
  "security.view",
  "syllabus.view",
];

/** PARTNER_ADMIN, FINANCE_ADMIN and CONTENT_REVIEWER are reserved: they grant nothing yet. */
export const ROLE_PERMISSIONS: Record<AdminRole, readonly AdminPermission[]> = {
  SUPER_ADMIN: ADMIN_PERMISSIONS,
  SUPPORT_ADMIN: SUPPORT_PERMISSIONS,
  PARTNER_ADMIN: [],
  FINANCE_ADMIN: [],
  CONTENT_REVIEWER: [],
};

/** Actions that also need a recent Google sign-in (see REAUTH_WINDOW_MS). */
export const HIGH_RISK_PERMISSIONS: readonly AdminPermission[] = [
  "users.suspend",
  "users.revokeSessions",
  "partners.decide",
  "flags.change",
  "roles.manage",
  "security.review",
  "syllabus.override",
];

export const REAUTH_WINDOW_MS = 60 * 60 * 1000;

/** The only role the admin API may grant or revoke; SUPER_ADMIN is managed by the ops script. */
export const API_GRANTABLE_ROLES: readonly AdminRole[] = ["SUPPORT_ADMIN"];

export const ADMIN_ROLE_LABELS: Record<AdminRole, string> = {
  SUPER_ADMIN: "Super admin",
  SUPPORT_ADMIN: "Support admin",
  PARTNER_ADMIN: "Partner admin",
  FINANCE_ADMIN: "Maliyyə admini",
  CONTENT_REVIEWER: "Kontent yoxlayıcısı",
};

export function permissionsOf(roles: readonly AdminRole[]): AdminPermission[] {
  const granted = new Set(roles.flatMap((r) => ROLE_PERMISSIONS[r]));
  return ADMIN_PERMISSIONS.filter((p) => granted.has(p));
}

/** SUPER_ADMIN counts only for e-mails on the SUPER_ADMIN_EMAILS allowlist. */
export function effectiveAdminRoles(roles: readonly AdminRole[], email: string | null, superAdminEmails: readonly string[]): AdminRole[] {
  const allowlisted = !!email && superAdminEmails.includes(email.trim().toLowerCase());
  return ADMIN_ROLES.filter((r) => roles.includes(r) && (r !== "SUPER_ADMIN" || allowlisted));
}

export const ACCOUNT_STATUSES = ["ACTIVE", "SUSPENDED"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const AUDIT_ACTIONS = [
  "USER_SUSPENDED",
  "USER_UNSUSPENDED",
  "USER_SESSIONS_REVOKED",
  "ROLE_GRANTED",
  "ROLE_REVOKED",
  "PARTNER_APPLIED",
  "PARTNER_APPLICATION_UPDATED",
  "PARTNER_APPROVED",
  "PARTNER_REJECTED",
  "PARTNER_INFO_REQUESTED",
  "PARTNER_SUSPENDED",
  "PARTNER_REACTIVATED",
  "FEATURE_FLAG_CHANGED",
  "SECURITY_EVENT_REVIEWED",
  "SYLLABUS_MANUAL_UNLOCK",
  "SYLLABUS_UNLOCK_REVOKED",
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_TARGET_TYPES = ["USER", "WORKSPACE", "PARTNER_PROFILE", "FEATURE_FLAG", "PLATFORM_ROLE", "SECURITY_EVENT", "SYLLABUS_ENROLLMENT"] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

export const SECURITY_EVENT_TYPES = [
  "ADMIN_ACCESS_DENIED",
  "WORKSPACE_HEADER_SPOOF",
  "RATE_LIMIT_BLOCK",
  "CSRF_REJECTED",
  "OAUTH_STATE_INVALID",
  "SUSPENDED_ACCESS",
  "ADMIN_ROLE_CHANGED",
  "FEATURE_FLAG_CHANGED",
] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];
export const SECURITY_SEVERITIES = ["LOW", "MEDIUM", "HIGH"] as const;
export type SecuritySeverity = (typeof SECURITY_SEVERITIES)[number];
export const SECURITY_EVENT_STATUSES = ["REVIEW_REQUIRED", "REVIEWED", "DISMISSED"] as const;
export type SecurityEventStatus = (typeof SECURITY_EVENT_STATUSES)[number];

/** New values go last: appending to a MySQL enum is an in-place change, reordering rebuilds the table. */
export const PARTNER_STATUSES = ["PENDING", "APPROVED", "REJECTED", "SUSPENDED", "INFO_REQUESTED"] as const;
export type PartnerStatus = (typeof PARTNER_STATUSES)[number];
export const PARTNER_DECISIONS = ["APPROVE", "REJECT", "REQUEST_INFO", "SUSPEND", "REACTIVATE"] as const;
export type PartnerDecision = (typeof PARTNER_DECISIONS)[number];

export const ADMIN_REASON_MIN = 10;
export const ADMIN_REASON_MAX = 500;
