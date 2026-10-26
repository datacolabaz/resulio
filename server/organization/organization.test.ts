import { describe, expect, it } from "vitest";
import {
  INVITABLE_ROLES,
  WORKSPACE_MEMBER_ROLES,
  assignableRoles,
  canAssignRole,
  canManageDepartments,
  canManageMembers,
  canRemoveRole,
  isOwnerEquivalent,
  memberDisplayStatus,
} from "../../shared/organization";

describe("isOwnerEquivalent / canManageMembers / canManageDepartments", () => {
  it("is true only for OWNER and ADMIN", () => {
    const owner = ["OWNER", "ADMIN"];
    for (const role of WORKSPACE_MEMBER_ROLES) {
      expect(isOwnerEquivalent(role)).toBe(owner.includes(role));
      expect(canManageMembers(role)).toBe(owner.includes(role));
      expect(canManageDepartments(role)).toBe(owner.includes(role));
    }
  });
});

describe("assignableRoles / canAssignRole", () => {
  it("OWNER may assign every invitable role, including ADMIN", () => {
    expect(assignableRoles("OWNER")).toEqual(["ADMIN", "HR_ADMIN", "TRAINER", "MANAGER"]);
    for (const role of INVITABLE_ROLES) expect(canAssignRole("OWNER", role)).toBe(true);
  });

  it("ADMIN may assign staff roles but never ADMIN or OWNER", () => {
    expect(canAssignRole("ADMIN", "HR_ADMIN")).toBe(true);
    expect(canAssignRole("ADMIN", "TRAINER")).toBe(true);
    expect(canAssignRole("ADMIN", "MANAGER")).toBe(true);
    expect(canAssignRole("ADMIN", "ADMIN")).toBe(false);
    expect(canAssignRole("ADMIN", "OWNER")).toBe(false);
  });

  it("no one below ADMIN may assign any role", () => {
    for (const actor of ["HR_ADMIN", "TRAINER", "MANAGER"] as const) {
      expect(assignableRoles(actor)).toEqual([]);
      for (const role of WORKSPACE_MEMBER_ROLES) expect(canAssignRole(actor, role)).toBe(false);
    }
  });
});

describe("canRemoveRole", () => {
  it("the OWNER seat can never be removed by anyone", () => {
    expect(canRemoveRole("OWNER", "OWNER")).toBe(false);
    expect(canRemoveRole("ADMIN", "OWNER")).toBe(false);
  });

  it("OWNER may remove any non-OWNER member, including another ADMIN", () => {
    for (const target of ["ADMIN", "HR_ADMIN", "TRAINER", "MANAGER"] as const) expect(canRemoveRole("OWNER", target)).toBe(true);
  });

  it("ADMIN may remove staff but never another ADMIN", () => {
    expect(canRemoveRole("ADMIN", "HR_ADMIN")).toBe(true);
    expect(canRemoveRole("ADMIN", "TRAINER")).toBe(true);
    expect(canRemoveRole("ADMIN", "MANAGER")).toBe(true);
    expect(canRemoveRole("ADMIN", "ADMIN")).toBe(false);
  });

  it("staff roles may never remove anyone", () => {
    for (const actor of ["HR_ADMIN", "TRAINER", "MANAGER"] as const) {
      for (const target of WORKSPACE_MEMBER_ROLES) expect(canRemoveRole(actor, target)).toBe(false);
    }
  });
});

describe("memberDisplayStatus", () => {
  const now = new Date("2026-10-26T00:00:00Z");

  it("ACTIVE and REVOKED pass through unchanged regardless of expiresAt", () => {
    expect(memberDisplayStatus({ status: "ACTIVE", expiresAt: new Date("2000-01-01") }, now)).toBe("ACTIVE");
    expect(memberDisplayStatus({ status: "REVOKED", expiresAt: null }, now)).toBe("REVOKED");
  });

  it("PENDING past its expiresAt reads as EXPIRED", () => {
    expect(memberDisplayStatus({ status: "PENDING", expiresAt: new Date("2026-10-25T00:00:00Z") }, now)).toBe("EXPIRED");
  });

  it("PENDING before its expiresAt (or with none) stays PENDING", () => {
    expect(memberDisplayStatus({ status: "PENDING", expiresAt: new Date("2026-11-01T00:00:00Z") }, now)).toBe("PENDING");
    expect(memberDisplayStatus({ status: "PENDING", expiresAt: null }, now)).toBe("PENDING");
  });
});
