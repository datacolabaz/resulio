import { and, eq } from "drizzle-orm";
import {
  HIGH_RISK_PERMISSIONS,
  REAUTH_WINDOW_MS,
  effectiveAdminRoles,
  permissionsOf,
  type AdminPermission,
  type AdminRole,
} from "../../../shared/adminPermissions";
import { authAccounts, type User } from "../../../drizzle/schema";
import { ENV } from "../../_core/env";
import type { RequestMeta } from "../../_core/requestMeta";
import type { SessionTimes } from "../../_core/sdk";
import { requireDb } from "../../db";
import { platformRolesOf } from "../access";

export type AdminIdentity = {
  userId: number;
  roles: AdminRole[];
  permissions: AdminPermission[];
  /** Highest role, recorded as actorAdminRole in audit rows. */
  primaryRole: AdminRole;
};

/** An authorized admin acting within one request. */
export type AdminContext = AdminIdentity & { meta: RequestMeta };

export type AdminDenial = "NOT_ADMIN" | "ADMIN_GOOGLE_REQUIRED" | "ADMIN_PERMISSION" | "REAUTH_REQUIRED";
export type AdminDecision = { ok: true; admin: AdminIdentity } | { ok: false; code: AdminDenial };

/** Roles that actually grant something: allowlist applied, reserved roles without permissions dropped. */
export function adminView(roles: readonly AdminRole[], email: string | null) {
  const effective = effectiveAdminRoles(roles, email, ENV.superAdminEmails).filter((r) => permissionsOf([r]).length > 0);
  if (!effective.length) return null;
  return { roles: effective, permissions: permissionsOf(effective) };
}

async function hasGoogleAccount(userId: number) {
  const [row] = await requireDb()
    .select({ id: authAccounts.id })
    .from(authAccounts)
    .where(and(eq(authAccounts.userId, userId), eq(authAccounts.provider, "google")))
    .limit(1);
  return !!row;
}

/**
 * The single admin authorization check: platform role, SUPER_ADMIN allowlist, Google sign-in in
 * production, the procedure's permission, and a recent sign-in for high-risk actions.
 */
export async function authorizeAdmin(
  user: Pick<User, "id" | "email">,
  session: SessionTimes | null | undefined,
  permission: AdminPermission,
  now = Date.now(),
): Promise<AdminDecision> {
  const view = adminView(await platformRolesOf(user.id), user.email);
  if (!view) return { ok: false, code: "NOT_ADMIN" };
  if (ENV.appEnv === "production" && !(await hasGoogleAccount(user.id))) return { ok: false, code: "ADMIN_GOOGLE_REQUIRED" };
  if (!view.permissions.includes(permission)) return { ok: false, code: "ADMIN_PERMISSION" };
  if (HIGH_RISK_PERMISSIONS.includes(permission) && (!session || now - session.authTimeMs > REAUTH_WINDOW_MS)) {
    return { ok: false, code: "REAUTH_REQUIRED" };
  }
  return { ok: true, admin: { userId: user.id, roles: view.roles, permissions: view.permissions, primaryRole: view.roles[0] } };
}
