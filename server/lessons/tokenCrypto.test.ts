import { randomBytes } from "crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "./tokenCrypto";

describe("encryptToken / decryptToken", () => {
  const original = process.env.LESSON_TOKEN_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.LESSON_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  });

  afterEach(() => {
    if (original === undefined) delete process.env.LESSON_TOKEN_ENCRYPTION_KEY;
    else process.env.LESSON_TOKEN_ENCRYPTION_KEY = original;
  });

  it("round-trips a token", () => {
    const token = "ya29.a0ARrdaM_fake_access_token_value";
    const cipher = encryptToken(token);
    expect(cipher).not.toContain(token);
    expect(decryptToken(cipher)).toBe(token);
  });

  it("produces a different ciphertext each time (random IV), but both decrypt to the same plaintext", () => {
    const token = "same-plaintext";
    const a = encryptToken(token);
    const b = encryptToken(token);
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe(token);
    expect(decryptToken(b)).toBe(token);
  });

  it("throws rather than silently returning garbage when the key changes", () => {
    const cipher = encryptToken("secret");
    process.env.LESSON_TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    expect(() => decryptToken(cipher)).toThrow();
  });

  it("rejects a key that isn't 32 bytes", () => {
    process.env.LESSON_TOKEN_ENCRYPTION_KEY = "too-short";
    expect(() => encryptToken("x")).toThrow(/32 bytes/);
  });

  it("throws clearly when the key is unset", () => {
    delete process.env.LESSON_TOKEN_ENCRYPTION_KEY;
    expect(() => encryptToken("x")).toThrow(/not configured/);
  });
});
