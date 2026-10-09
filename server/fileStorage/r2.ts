import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/**
 * Cloudflare R2 (S3-compatible) object store for file bytes. Off unless R2_ACCOUNT_ID,
 * R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET are all set; FILE_STORAGE_BACKEND=db keeps
 * new uploads in MySQL even then (e.g. while copying old files over). Credentials stay in the
 * environment, never in the database. See docs/FILE-STORAGE.md.
 */

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Optional public bucket / custom domain; used only for files anyone may open. */
  publicBaseUrl: string;
  /** Override for S3-compatible test servers; default https://<account>.r2.cloudflarestorage.com. */
  endpoint: string;
}

const env = (e: NodeJS.ProcessEnv, key: string) => (e[key] ?? "").trim().replace(/^['"]|['"]$/g, "").trim();

export function r2ConfigFromEnv(e: NodeJS.ProcessEnv = process.env): R2Config | null {
  const accountId = env(e, "R2_ACCOUNT_ID");
  const accessKeyId = env(e, "R2_ACCESS_KEY_ID");
  const secretAccessKey = env(e, "R2_SECRET_ACCESS_KEY");
  const bucket = env(e, "R2_BUCKET");
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    publicBaseUrl: env(e, "R2_PUBLIC_BASE_URL").replace(/\/+$/, ""),
    endpoint: env(e, "R2_ENDPOINT") || `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

/** "redirect" (default): a short-lived signed URL after the app's own access check; "proxy": the API streams the bytes. */
export function r2DownloadMode(e: NodeJS.ProcessEnv = process.env): "redirect" | "proxy" {
  return env(e, "R2_DOWNLOAD_MODE").toLowerCase() === "proxy" ? "proxy" : "redirect";
}

/** Where new uploads go: R2 when configured, unless FILE_STORAGE_BACKEND=db. */
export function uploadBackend(e: NodeJS.ProcessEnv = process.env): "db" | "r2" {
  if (env(e, "FILE_STORAGE_BACKEND").toLowerCase() === "db") return "db";
  return r2ConfigFromEnv(e) ? "r2" : "db";
}

export const SIGNED_URL_TTL_SECONDS = 300;

/** The subset of S3Client the store uses, so tests can pass a fake. */
export interface S3Like {
  send(command: unknown): Promise<unknown>;
}

export interface ObjectStore {
  backend: "r2";
  bucket: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Size in bytes, or null when the object does not exist. */
  head(key: string): Promise<number | null>;
  remove(key: string): Promise<void>;
  signedGetUrl(key: string, opts: { fileName: string; contentType: string; expiresIn?: number }): Promise<string>;
  publicUrl(key: string): string | null;
}

/** RFC 6266 attachment header with an ASCII fallback, same as the MySQL-backed download. */
export function contentDisposition(fileName: string) {
  const asciiName = fileName.replace(/[^\x20-\x7E]/g, "_").replace(/"/g, "'");
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

type Presign = (client: S3Like, command: GetObjectCommand, opts: { expiresIn: number }) => Promise<string>;

export function createR2Store(config: R2Config, client?: S3Like, presign?: Presign): ObjectStore {
  const s3: S3Like =
    client ??
    new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  const sign: Presign = presign ?? ((c, command, opts) => getSignedUrl(c as S3Client, command, opts));
  const Bucket = config.bucket;
  return {
    backend: "r2",
    bucket: Bucket,
    async put(key, body, contentType) {
      await s3.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.byteLength }));
    },
    async get(key) {
      const out = (await s3.send(new GetObjectCommand({ Bucket, Key: key }))) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
      if (!out.Body) throw new Error(`R2 object ${key} has no body`);
      return Buffer.from(await out.Body.transformToByteArray());
    },
    async head(key) {
      try {
        const out = (await s3.send(new HeadObjectCommand({ Bucket, Key: key }))) as { ContentLength?: number };
        return out.ContentLength ?? 0;
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number }; name?: string }) ?? {};
        if (status.$metadata?.httpStatusCode === 404 || status.name === "NotFound") return null;
        throw error;
      }
    },
    async remove(key) {
      await s3.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    signedGetUrl(key, opts) {
      const command = new GetObjectCommand({ Bucket, Key: key, ResponseContentDisposition: contentDisposition(opts.fileName), ResponseContentType: opts.contentType });
      return sign(s3, command, { expiresIn: opts.expiresIn ?? SIGNED_URL_TTL_SECONDS });
    },
    publicUrl(key) {
      return config.publicBaseUrl ? `${config.publicBaseUrl}/${key.split("/").map(encodeURIComponent).join("/")}` : null;
    },
  };
}

let current: { signature: string; store: ObjectStore } | null = null;

/** The configured store, or null when R2 is not configured. Rebuilt if the env changes (tests). */
export function objectStore(e: NodeJS.ProcessEnv = process.env): ObjectStore | null {
  const config = r2ConfigFromEnv(e);
  if (!config) return null;
  const signature = JSON.stringify(config);
  if (current?.signature !== signature) current = { signature, store: createR2Store(config) };
  return current.store;
}

/** Object key for a file: grouped by workspace, unguessable through the file id. */
export function objectKeyFor(file: { id: string; workspaceId: string; fileName: string }) {
  const dot = file.fileName.lastIndexOf(".");
  const ext = dot === -1 ? "" : file.fileName.slice(dot).toLowerCase().replace(/[^.a-z0-9]/g, "");
  return `files/${file.workspaceId}/${file.id}${ext}`;
}
