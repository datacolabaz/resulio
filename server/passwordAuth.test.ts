import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeEmail, PASSWORD_PROVIDER } from "../shared/auth";
import { providerLinkPlan, setPasswordDecision, type LinkCandidate } from "./_core/accountLinking";
import { hashPassword, needsRehash, SCRYPT_PARAMS, verifyPassword } from "./_core/password";
import { requireDb } from "./db";
import { loginWithPassword, registerWithPassword, setOwnPassword } from "./modules/passwordAuth";

vi.mock("./db", () => ({ requireDb: vi.fn() }));
// Production-strength scrypt is deliberately slow (hundreds of ms per hash on a slow CI box).
vi.setConfig({ testTimeout: 30_000 });

const WEAK = { N: 2 ** 10, r: 8, p: 1 };

describe("password hashing", () => {
  it("verifies the right password and rejects a wrong one", async () => {
    const hash = await hashPassword("düzgün-parol-123");
    expect(hash).toMatch(/^scrypt\$32768\$8\$3\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(hash).not.toContain("düzgün");
    expect(await verifyPassword("düzgün-parol-123", hash)).toBe(true);
    expect(await verifyPassword("düzgün-parol-124", hash)).toBe(false);
    expect(await verifyPassword("", hash)).toBe(false);
  });

  it("salts every hash, so equal passwords never produce equal hashes", async () => {
    const [a, b] = await Promise.all([hashPassword("same-password", WEAK), hashPassword("same-password", WEAK)]);
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it("treats canonically equivalent Unicode spellings as the same password", async () => {
    const hash = await hashPassword("caf\u00e9-parol", WEAK);
    expect(await verifyPassword("cafe\u0301-parol", hash)).toBe(true);
  });

  it("rejects missing, malformed and out-of-bounds hashes without throwing", async () => {
    expect(await verifyPassword("anything", null)).toBe(false);
    expect(await verifyPassword("anything", undefined)).toBe(false);
    expect(await verifyPassword("anything", "plaintext")).toBe(false);
    expect(await verifyPassword("anything", "bcrypt$2b$10$abc")).toBe(false);
    const valid = await hashPassword("anything", WEAK);
    const huge = valid.replace(/^scrypt\$1024\$/, `scrypt$${2 ** 24}$`);
    expect(await verifyPassword("anything", huge)).toBe(false);
  });

  it("flags hashes made with older parameters for rehashing", async () => {
    expect(needsRehash(await hashPassword("x".repeat(8), WEAK))).toBe(true);
    expect(needsRehash(await hashPassword("x".repeat(8), SCRYPT_PARAMS))).toBe(false);
    expect(needsRehash("garbage")).toBe(false);
  });
});

describe("normalizeEmail", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Aysel.Mammadova@Gmail.COM \n")).toBe("aysel.mammadova@gmail.com");
    expect(normalizeEmail("a@b.az")).toBe("a@b.az");
  });
});

describe("providerLinkPlan (first Google sign-in for an email that already has users)", () => {
  const c = (over: Partial<LinkCandidate>): LinkCandidate => ({ userId: 1, providers: [], hasPassword: false, loginMethod: null, ...over });

  it("creates a new user when nobody has the email", () => {
    expect(providerLinkPlan("google", [])).toEqual({ action: "CREATE" });
  });

  it("links a legacy user with no provider at all and keeps everything", () => {
    expect(providerLinkPlan("google", [c({ userId: 4 })])).toEqual({ action: "LINK", userId: 4, dropPassword: false });
  });

  it("links an email + password account but drops its unverified password", () => {
    const plan = providerLinkPlan("google", [c({ userId: 9, providers: [PASSWORD_PROVIDER], hasPassword: true, loginMethod: PASSWORD_PROVIDER })]);
    expect(plan).toEqual({ action: "LINK", userId: 9, dropPassword: true });
  });

  it("never merges into a user already linked to a (different) Google account", () => {
    expect(providerLinkPlan("google", [c({ providers: ["google"] })])).toEqual({ action: "CREATE" });
    expect(providerLinkPlan("google", [c({ providers: ["google", PASSWORD_PROVIDER], hasPassword: true })])).toEqual({ action: "CREATE" });
  });

  it("ignores demo accounts and refuses to guess between several eligible users", () => {
    expect(providerLinkPlan("google", [c({ loginMethod: "demo" })])).toEqual({ action: "CREATE" });
    expect(providerLinkPlan("google", [c({ userId: 1 }), c({ userId: 2, providers: [PASSWORD_PROVIDER], hasPassword: true })])).toEqual({ action: "CREATE" });
  });

  it("picks the single eligible user next to ineligible ones", () => {
    const plan = providerLinkPlan("google", [c({ userId: 1, providers: ["google"] }), c({ userId: 2, providers: [PASSWORD_PROVIDER], hasPassword: true })]);
    expect(plan).toEqual({ action: "LINK", userId: 2, dropPassword: true });
  });
});

describe("setPasswordDecision (self-service password from Settings)", () => {
  const base = { hasEmail: true, hasPassword: false, currentPasswordOk: false, recentSignIn: true, emailUsedByOtherUser: false };

  it("lets a recently signed-in Google user add a first password", () => {
    expect(setPasswordDecision(base)).toBeNull();
  });

  it("requires a recent sign-in to add the first password", () => {
    expect(setPasswordDecision({ ...base, recentSignIn: false })).toBe("REAUTH_REQUIRED");
  });

  it("requires the current password to change an existing one, even with a fresh session", () => {
    expect(setPasswordDecision({ ...base, hasPassword: true })).toBe("INVALID_CURRENT_PASSWORD");
    expect(setPasswordDecision({ ...base, hasPassword: true, currentPasswordOk: true, recentSignIn: false })).toBeNull();
  });

  it("refuses accounts without an email and emails that are another user's password login", () => {
    expect(setPasswordDecision({ ...base, hasEmail: false })).toBe("PASSWORD_NO_EMAIL");
    expect(setPasswordDecision({ ...base, emailUsedByOtherUser: true })).toBe("PASSWORD_EMAIL_IN_USE");
  });
});

// ---------------------------------------------------------------------------
// passwordAuth module against a minimal fake of the drizzle query builder
// ---------------------------------------------------------------------------

type Logged = { op: "update" | "insert" | "delete"; values?: Record<string, unknown> };

function fakeDb(opts: { selects?: unknown[][]; insertError?: unknown } = {}) {
  const selects = [...(opts.selects ?? [])];
  const log: Logged[] = [];
  const query = (rows: unknown[]) => {
    const q: Record<string, unknown> = {};
    for (const m of ["from", "innerJoin", "leftJoin", "where"]) q[m] = () => q;
    q.limit = () => Promise.resolve(rows);
    return q;
  };
  const db: Record<string, unknown> = {
    select: () => query(selects.shift() ?? []),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        log.push({ op: "update", values });
        return { where: () => Promise.resolve() };
      },
    }),
    delete: () => {
      log.push({ op: "delete" });
      return { where: () => Promise.resolve() };
    },
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        if (opts.insertError) throw opts.insertError;
        log.push({ op: "insert", values });
        return Object.assign(Promise.resolve(), { $returningId: () => Promise.resolve([{ id: 99 }]) });
      },
    }),
    transaction: (fn: (tx: unknown) => unknown) => fn(db),
  };
  vi.mocked(requireDb).mockReturnValue(db as never);
  return log;
}

const userRow = (over: Record<string, unknown> = {}) =>
  ({ id: 5, openId: "usr_x", name: "Aysel", email: "aysel@example.az", passwordHash: null, sessionsValidAfter: null, ...over }) as never;

beforeEach(() => vi.mocked(requireDb).mockReset());

describe("loginWithPassword", () => {
  it("gives the same INVALID_CREDENTIALS for an unknown email and a wrong password", async () => {
    fakeDb({ selects: [[]] });
    await expect(loginWithPassword({ email: "nobody@example.az", password: "whatever1" })).rejects.toThrow("INVALID_CREDENTIALS");

    const passwordHash = await hashPassword("right-password");
    fakeDb({ selects: [[{ user: userRow({ passwordHash }) }]] });
    await expect(loginWithPassword({ email: "aysel@example.az", password: "wrong-password" })).rejects.toThrow("INVALID_CREDENTIALS");
  });

  it("signs in a returning user and records the sign-in time", async () => {
    const passwordHash = await hashPassword("right-password");
    const log = fakeDb({ selects: [[{ user: userRow({ passwordHash }) }]] });
    const result = await loginWithPassword({ email: "  AYSEL@example.az ", password: "right-password" });
    expect(result).toMatchObject({ isNew: false, user: { id: 5 } });
    expect(log).toHaveLength(1);
    expect(log[0].values?.lastSignedIn).toBeInstanceOf(Date);
    expect(log[0].values?.passwordHash).toBeUndefined();
  });

  it("upgrades a hash made with older parameters on successful sign-in", async () => {
    const passwordHash = await hashPassword("right-password", WEAK);
    const log = fakeDb({ selects: [[{ user: userRow({ passwordHash }) }]] });
    await loginWithPassword({ email: "aysel@example.az", password: "right-password" });
    const upgraded = log[0].values?.passwordHash as string;
    expect(needsRehash(upgraded)).toBe(false);
    expect(await verifyPassword("right-password", upgraded)).toBe(true);
  });
});

describe("registerWithPassword", () => {
  it("refuses an email that already has any account, without attaching a password to it", async () => {
    const log = fakeDb({ selects: [[{ id: 1 }]] });
    await expect(registerWithPassword({ email: "Google.User@gmail.com", password: "attacker-pass", name: "X" })).rejects.toThrow("REGISTRATION_UNAVAILABLE");
    expect(log).toEqual([]);
  });

  it("creates the user with a normalized email, a hash (never the password) and a password auth link", async () => {
    const log = fakeDb({ selects: [[], [userRow()]] });
    const result = await registerWithPassword({ email: " New.Student@Example.AZ ", password: "my-secret-pass", name: "Yeni Tələbə" });
    expect(result.isNew).toBe(true);
    const [userInsert, linkInsert] = log;
    expect(userInsert.values).toMatchObject({ email: "new.student@example.az", loginMethod: PASSWORD_PROVIDER, name: "Yeni Tələbə" });
    expect(String(userInsert.values?.passwordHash)).toMatch(/^scrypt\$/);
    expect(JSON.stringify(log)).not.toContain("my-secret-pass");
    expect(linkInsert.values).toMatchObject({ userId: 99, provider: PASSWORD_PROVIDER, providerAccountId: "new.student@example.az" });
  });

  it("maps a concurrent duplicate sign-up to the same generic refusal", async () => {
    fakeDb({ selects: [[]], insertError: Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY", errno: 1062 }) });
    await expect(registerWithPassword({ email: "race@example.az", password: "race-password", name: "R" })).rejects.toThrow("REGISTRATION_UNAVAILABLE");
  });
});

describe("setOwnPassword", () => {
  const NOW = 1_800_000_000_000;
  const fresh = { issuedAtMs: NOW - 60_000, authTimeMs: NOW - 60_000 };
  const stale = { issuedAtMs: NOW - 3 * 3600_000, authTimeMs: NOW - 3 * 3600_000 };

  it("adds a first password for a recently signed-in Google user without ending other sessions", async () => {
    const log = fakeDb({ selects: [[]] });
    const result = await setOwnPassword(userRow(), fresh, { newPassword: "brand-new-pass" }, NOW);
    expect(result).toEqual({ revokedOtherSessions: false });
    expect(log.map((l) => l.op)).toEqual(["update", "delete", "insert"]);
    expect(log[0].values?.sessionsValidAfter).toBeUndefined();
    expect(log[2].values).toMatchObject({ provider: PASSWORD_PROVIDER, providerAccountId: "aysel@example.az", userId: 5 });
  });

  it("refuses a first password on an old session", async () => {
    const log = fakeDb({ selects: [[]] });
    await expect(setOwnPassword(userRow(), stale, { newPassword: "brand-new-pass" }, NOW)).rejects.toThrow("REAUTH_REQUIRED");
    expect(log).toEqual([]);
  });

  it("changes a password only with the current one, and then ends other sessions", async () => {
    const passwordHash = await hashPassword("old-password", WEAK);
    fakeDb({ selects: [[]] });
    await expect(setOwnPassword(userRow({ passwordHash }), fresh, { currentPassword: "guess", newPassword: "new-password" }, NOW)).rejects.toThrow(
      "INVALID_CURRENT_PASSWORD",
    );

    const log = fakeDb({ selects: [[]] });
    const result = await setOwnPassword(userRow({ passwordHash }), stale, { currentPassword: "old-password", newPassword: "new-password" }, NOW);
    expect(result).toEqual({ revokedOtherSessions: true });
    expect(log[0].values?.sessionsValidAfter).toEqual(new Date(NOW));
  });

  it("refuses when the email is already another user's password login", async () => {
    fakeDb({ selects: [[{ id: 3 }]] });
    await expect(setOwnPassword(userRow(), fresh, { newPassword: "brand-new-pass" }, NOW)).rejects.toThrow("PASSWORD_EMAIL_IN_USE");
  });
});
