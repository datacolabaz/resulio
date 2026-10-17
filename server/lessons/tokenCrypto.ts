import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { ENV } from "../_core/env";

/**
 * AES-256-GCM at-rest encryption for the meeting-provider OAuth tokens stored in
 * `teacher_meeting_connections` -- unlike the MCP connector's own tokens (hashed, verify-only),
 * these must be reversible: the sweepers and meeting-creation calls need the real access/refresh
 * token to call Google/Zoom on the teacher's behalf. Output is `v1:<iv>:<authTag>:<ciphertext>`,
 * each part base64url, so the cipher version can change later without a migration.
 */

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

function keyBytes(): Buffer {
  const raw = ENV.lessonTokenEncryptionKey;
  if (!raw) throw new Error("LESSON_TOKEN_ENCRYPTION_KEY is not configured");
  const buf = /^[0-9a-fA-F]+$/.test(raw) && raw.length === 64 ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("LESSON_TOKEN_ENCRYPTION_KEY must decode to 32 bytes (hex or base64)");
  return buf;
}

export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, keyBytes(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), authTag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function decryptToken(stored: string): string {
  const [version, ivB64, tagB64, dataB64] = stored.split(":");
  if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) throw new Error("Unrecognized token cipher format");
  const decipher = createDecipheriv(ALGO, keyBytes(), Buffer.from(ivB64, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64url")), decipher.final()]);
  return plaintext.toString("utf8");
}
