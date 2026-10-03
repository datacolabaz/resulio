import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "crypto";

/**
 * scrypt via Node's built-in crypto: no native addon to build on Windows or Railway, and it runs on
 * the libuv threadpool, so at most a handful of hashes are ever in memory at once.
 * N=2^15, r=8, p=3 is one of OWASP's recommended scrypt settings (32 MiB per hash).
 * Parameters are stored inside each hash, so they can be raised later without invalidating old ones.
 */
export type ScryptParams = { N: number; r: number; p: number };
export const SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 3 };

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const PREFIX = "scrypt";

function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  const options: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: 256 * params.N * params.r };
  return new Promise((resolve, reject) => {
    scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

export async function hashPassword(password: string, params: ScryptParams = SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, params);
  return [PREFIX, params.N, params.r, params.p, salt.toString("base64"), key.toString("base64")].join("$");
}

type ParsedHash = { params: ScryptParams; salt: Buffer; key: Buffer };

function parseHash(stored: string | null | undefined): ParsedHash | null {
  if (!stored) return null;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  // Bounds keep a corrupted row from turning one login into a multi-gigabyte allocation.
  const powerOfTwo = Number.isInteger(N) && N >= 2 ** 10 && N <= 2 ** 20 && (N & (N - 1)) === 0;
  if (!powerOfTwo || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return null;
  const salt = Buffer.from(parts[4], "base64");
  const key = Buffer.from(parts[5], "base64");
  if (salt.length < 8 || key.length !== KEY_LENGTH) return null;
  return { params: { N, r, p }, salt, key };
}

const DUMMY_SALT = Buffer.alloc(SALT_LENGTH, 7);

/**
 * Constant-shape check: with no (or a malformed) stored hash it still does the full scrypt work,
 * so "no such account" and "wrong password" take the same time and can't be told apart.
 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) {
    await derive(password, DUMMY_SALT, SCRYPT_PARAMS);
    return false;
  }
  const key = await derive(password, parsed.salt, parsed.params);
  return timingSafeEqual(key, parsed.key);
}

/** True when a valid hash was made with weaker-than-current parameters and should be replaced on next sign-in. */
export function needsRehash(stored: string, params: ScryptParams = SCRYPT_PARAMS): boolean {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  return parsed.params.N !== params.N || parsed.params.r !== params.r || parsed.params.p !== params.p;
}
