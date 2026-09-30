// Grants or revokes a platform admin role. This is the only way to manage SUPER_ADMIN; the admin
// API can only grant SUPPORT_ADMIN. Every change writes a SYSTEM audit row.
//
// SUPER_ADMIN requires the e-mail to be on SUPER_ADMIN_EMAILS (the same allowlist the server applies
// at request time), and the last SUPER_ADMIN cannot be revoked. Without --yes it only prints the plan.
//
// Usage:
//   DATABASE_URL=... SUPER_ADMIN_EMAILS=a@x.az pnpm admin:grant --email a@x.az --role SUPER_ADMIN --reason "Initial platform owner" [--revoke] [--yes]
import { parseArgs } from "node:util";
import { eq, sql } from "drizzle-orm";
import { ADMIN_REASON_MAX, ADMIN_REASON_MIN, ADMIN_ROLES, type AdminRole } from "../shared/adminPermissions";
import { users } from "../drizzle/schema";
import { ENV } from "../server/_core/env";
import { requireDb } from "../server/db";
import { systemGrantRole, systemRevokeRole } from "../server/modules/admin/roles";
import { platformRolesOf } from "../server/modules/access";
import { settleSecurityEvents } from "../server/modules/securityEvents";

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

async function main() {
  const { values } = parseArgs({
    options: {
      email: { type: "string" },
      role: { type: "string" },
      reason: { type: "string" },
      revoke: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
    },
  });
  const email = values.email?.trim().toLowerCase();
  const role = values.role as AdminRole | undefined;
  const reason = values.reason?.trim() ?? "";
  if (!email) fail("--email is required");
  if (!role || !ADMIN_ROLES.includes(role)) fail(`--role must be one of ${ADMIN_ROLES.join(", ")}`);
  if (reason.length < ADMIN_REASON_MIN || reason.length > ADMIN_REASON_MAX) fail(`--reason must be ${ADMIN_REASON_MIN}-${ADMIN_REASON_MAX} characters`);
  if (!values.revoke && role === "SUPER_ADMIN" && !ENV.superAdminEmails.includes(email)) {
    fail("SUPER_ADMIN can only be granted to an e-mail listed in SUPER_ADMIN_EMAILS");
  }

  const db = requireDb();
  const matches = await db.select({ id: users.id, email: users.email, name: users.name }).from(users).where(eq(sql`lower(${users.email})`, email));
  if (matches.length === 0) fail(`No user with e-mail ${email}. The person must sign in with Google once first.`);
  if (matches.length > 1) fail(`${matches.length} users share e-mail ${email}; resolve the duplicate before granting a role.`);
  const target = matches[0];
  const current = await platformRolesOf(target.id);

  console.log(`Database: ${new URL(process.env.DATABASE_URL!).host}${new URL(process.env.DATABASE_URL!).pathname}`);
  console.log(`User #${target.id} ${target.name ?? ""} <${target.email}> current roles: ${current.join(", ") || "none"}`);
  console.log(`Plan: ${values.revoke ? "REVOKE" : "GRANT"} ${role} — reason: ${reason}`);
  if (!values.yes) {
    console.log("Dry run. Re-run with --yes to apply.");
    return;
  }

  const result = values.revoke
    ? await systemRevokeRole(target.id, role, reason)
    : await systemGrantRole(target.id, target.email, role, reason, ENV.superAdminEmails);
  await settleSecurityEvents();
  console.log(`Done: ${JSON.stringify(result)} (SYSTEM audit row written)`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
