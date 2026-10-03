import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { authAccounts, users } from "../../drizzle/schema";
import { resetRateLimits } from "../_core/rateLimit";
import * as db from "../db";
import * as passwordAuth from "../modules/passwordAuth";
import { db as testDb, makeUser } from "./fixtures";

beforeEach(() => resetRateLimits());

describe("email + password accounts", () => {
  it("registers, signs in case-insensitively, and refuses a second sign-up for the same email", async () => {
    const email = `pw.${Date.now()}@example.test`;
    const created = await passwordAuth.registerWithPassword({ email: email.toUpperCase(), password: "first-password", name: "Parol istifadəçisi" });
    expect(created.isNew).toBe(true);
    expect(created.user.email).toBe(email);

    const login = await passwordAuth.loginWithPassword({ email: ` ${email.toUpperCase()} `, password: "first-password" });
    expect(login.user.id).toBe(created.user.id);
    await expect(passwordAuth.loginWithPassword({ email, password: "wrong-password" })).rejects.toThrow("INVALID_CREDENTIALS");
    await expect(passwordAuth.registerWithPassword({ email, password: "second-password", name: "İkinci" })).rejects.toThrow("REGISTRATION_UNAVAILABLE");
  });

  it("never lets sign-up attach a password to an existing Google account", async () => {
    const google = await makeUser("Google istifadəçisi");
    await testDb().insert(authAccounts).values({ userId: google.id, provider: "google", providerAccountId: `g_${Date.now()}`, providerEmail: google.email });

    await expect(passwordAuth.registerWithPassword({ email: google.email!, password: "attacker-pass", name: "Attacker" })).rejects.toThrow(
      "REGISTRATION_UNAVAILABLE",
    );
    const [row] = await testDb().select().from(users).where(eq(users.id, google.id));
    expect(row.passwordHash).toBeNull();
    await expect(passwordAuth.loginWithPassword({ email: google.email!, password: "attacker-pass" })).rejects.toThrow("INVALID_CREDENTIALS");
  });

  it("Google sign-in for a password account's email reaches the same user and drops the unverified password", async () => {
    const email = `squat.${Date.now()}@example.test`;
    const created = await passwordAuth.registerWithPassword({ email, password: "squatter-pass", name: "Squatter" });

    const linked = await db.upsertProviderUser({ provider: "google", providerAccountId: `sub_${Date.now()}_pw`, email, name: "Real Owner", avatarUrl: null });
    expect(linked.user.id).toBe(created.user.id);
    expect(linked.isNew).toBe(false);
    expect(linked.droppedPassword).toBe(true);
    expect(linked.user.passwordHash).toBeNull();
    expect(linked.user.sessionsValidAfter).not.toBeNull();

    await expect(passwordAuth.loginWithPassword({ email, password: "squatter-pass" })).rejects.toThrow("INVALID_CREDENTIALS");
    const links = await testDb().select().from(authAccounts).where(eq(authAccounts.userId, created.user.id));
    expect(links.map((l) => l.provider)).toEqual(["google"]);
  });

  it("a Google user who adds a password in Settings can sign in with it, and Google keeps reaching the same user", async () => {
    const sub = `sub_${Date.now()}_settings`;
    const email = `settings.${Date.now()}@example.test`;
    const { user } = await db.upsertProviderUser({ provider: "google", providerAccountId: sub, email, name: "G", avatarUrl: null });
    const now = Date.now();
    await passwordAuth.setOwnPassword(user, { issuedAtMs: now, authTimeMs: now }, { newPassword: "settings-pass" });

    const login = await passwordAuth.loginWithPassword({ email, password: "settings-pass" });
    expect(login.user.id).toBe(user.id);

    const again = await db.upsertProviderUser({ provider: "google", providerAccountId: sub, email, name: "G", avatarUrl: null });
    expect(again.user.id).toBe(user.id);
    expect(again.droppedPassword).toBeUndefined();
    expect(again.user.passwordHash).not.toBeNull();
  });
});
