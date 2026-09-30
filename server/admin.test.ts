import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  ADMIN_PERMISSIONS,
  API_GRANTABLE_ROLES,
  HIGH_RISK_PERMISSIONS,
  ROLE_PERMISSIONS,
  effectiveAdminRoles,
  permissionsOf,
} from "../shared/adminPermissions";
import { hashIp, summarizeUserAgent } from "./_core/requestMeta";
import { assertAuditSafe } from "./modules/admin/audit";
import { AppError } from "./modules/errors";

describe("admin permission map", () => {
  it("gives SUPER_ADMIN everything and SUPPORT_ADMIN read-only access", () => {
    expect(permissionsOf(["SUPER_ADMIN"])).toEqual([...ADMIN_PERMISSIONS]);
    const support = permissionsOf(["SUPPORT_ADMIN"]);
    expect(support).toContain("users.view");
    expect(support).toContain("audit.viewSupport");
    for (const p of HIGH_RISK_PERMISSIONS) expect(support).not.toContain(p);
    expect(support).not.toContain("audit.view");
    expect(support).not.toContain("system.notify");
  });

  it("keeps reserved roles empty and only SUPPORT_ADMIN grantable through the API", () => {
    expect(ROLE_PERMISSIONS.PARTNER_ADMIN).toEqual([]);
    expect(ROLE_PERMISSIONS.FINANCE_ADMIN).toEqual([]);
    expect(ROLE_PERMISSIONS.CONTENT_REVIEWER).toEqual([]);
    expect(API_GRANTABLE_ROLES).toEqual(["SUPPORT_ADMIN"]);
  });

  it("drops SUPER_ADMIN unless the e-mail is allowlisted (case-insensitive)", () => {
    expect(effectiveAdminRoles(["SUPER_ADMIN", "SUPPORT_ADMIN"], "a@x.az", [])).toEqual(["SUPPORT_ADMIN"]);
    expect(effectiveAdminRoles(["SUPER_ADMIN"], " A@X.az ", ["a@x.az"])).toEqual(["SUPER_ADMIN"]);
    expect(effectiveAdminRoles(["SUPER_ADMIN"], null, ["a@x.az"])).toEqual([]);
  });
});

describe("audit metadata", () => {
  it("rejects secrets, answers and content at any depth", () => {
    expect(() => assertAuditSafe({ status: "ACTIVE", nested: { reason: "ok" } })).not.toThrow();
    for (const key of ["token", "accessToken", "password", "answers", "answerKey", "content", "fileUrl", "Cookie", "sessionToken"]) {
      expect(() => assertAuditSafe({ outer: { [key]: "x" } })).toThrow(AppError);
    }
  });

  it("stores only a keyed IP hash and a coarse user agent", () => {
    process.env.AUDIT_HASH_SECRET = "unit-test-audit-secret";
    const h = hashIp("203.0.113.9");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain("203.0.113.9");
    expect(hashIp("203.0.113.9")).toBe(h);
    delete process.env.AUDIT_HASH_SECRET;
    expect(summarizeUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0 Safari/537.36")).toBe("Chrome / Windows");
  });
});

describe("append-only audit log", () => {
  const serverDir = path.resolve(import.meta.dirname);
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) return name === "integration" ? [] : files(full);
      return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [full] : [];
    });

  it("has no update or delete path for audit_logs in server code", () => {
    const offenders = files(serverDir).filter((f) => /\.(update|delete)\(\s*auditLogs\b/.test(readFileSync(f, "utf8")) || /(UPDATE|DELETE FROM)\s+`?audit_logs/i.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("writes audit rows only through appendAudit", () => {
    const writers = files(serverDir).filter((f) => /\.insert\(\s*auditLogs\b/.test(readFileSync(f, "utf8")));
    expect(writers.map((f) => path.relative(serverDir, f).replace(/\\/g, "/"))).toEqual(["modules/admin/audit.ts"]);
  });
});
