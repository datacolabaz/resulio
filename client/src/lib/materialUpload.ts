import { API_BASE } from "@/const";
import { UploadError, type UploadedFile } from "@/lib/uploadFile";
import { MB, UPLOAD_TYPES, KIND_SIZE_CLASS, extensionOfName, type MaterialKind } from "@shared/materialTemplates";

/**
 * Material files: up to the server limit (8 MB) through `/api/files/upload` as before; larger ones
 * straight to R2 with URLs the API signs (docs/MATERIALS.md, "Large uploads"). Both report
 * progress and stop on `signal`.
 */

export interface UploadConfig {
  direct: boolean;
  serverMaxBytes: number;
  limitsMb: Record<string, number>;
}

export interface DirectUploadApi {
  start(input: { fileName: string; sizeBytes: number; kind: MaterialKind }): Promise<{ sessionId: string; mode: "single" | "multipart"; url: string | null; contentType: string; partSize: number | null; partCount: number }>;
  partUrls(input: { sessionId: string; partNumbers: number[] }): Promise<Array<{ partNumber: number; url: string }>>;
  complete(input: { sessionId: string }): Promise<{ id: string; name: string; size: number; mimeType: string }>;
  abort(input: { sessionId: string }): Promise<unknown>;
}

const PART_URL_BATCH = 20;
const PARALLEL_PARTS = 3;

/** The largest file this kind may upload now: the kind's limit with R2, else the server limit. */
export function maxBytesFor(kind: MaterialKind, config: UploadConfig): number {
  const kindMax = (config.limitsMb[KIND_SIZE_CLASS[kind]] ?? 0) * MB;
  return config.direct ? Math.max(kindMax, config.serverMaxBytes) : config.serverMaxBytes;
}

/** Extensions the file picker offers for this kind. */
export function acceptFor(kind: MaterialKind): string {
  return Object.keys(UPLOAD_TYPES[KIND_SIZE_CLASS[kind]]).join(",");
}

/** Checked before anything is sent; the server checks again. */
export function precheck(file: File, kind: MaterialKind, config: UploadConfig): "FILE_TYPE_NOT_ALLOWED" | "FILE_TOO_LARGE" | null {
  if (!UPLOAD_TYPES[KIND_SIZE_CLASS[kind]][extensionOfName(file.name)]) return "FILE_TYPE_NOT_ALLOWED";
  if (file.size <= 0 || file.size > maxBytesFor(kind, config)) return "FILE_TOO_LARGE";
  return null;
}

function send(method: "POST" | "PUT", url: string, body: Blob | FormData, opts: { signal: AbortSignal; onProgress: (loaded: number) => void; headers?: Record<string, string>; credentials?: boolean }): Promise<XMLHttpRequest> {
  return new Promise((resolve, reject) => {
    if (opts.signal.aborted) return reject(new UploadError("UPLOAD_CANCELLED"));
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.withCredentials = !!opts.credentials;
    for (const [k, v] of Object.entries(opts.headers ?? {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => opts.onProgress(e.loaded);
    const onAbort = () => xhr.abort();
    opts.signal.addEventListener("abort", onAbort, { once: true });
    xhr.onload = () => {
      opts.signal.removeEventListener("abort", onAbort);
      resolve(xhr);
    };
    xhr.onerror = () => {
      opts.signal.removeEventListener("abort", onAbort);
      reject(new UploadError("UPLOAD_FAILED"));
    };
    xhr.onabort = () => reject(new UploadError("UPLOAD_CANCELLED"));
    xhr.send(body);
  });
}

async function viaServer(file: File, signal: AbortSignal, onProgress: (fraction: number) => void): Promise<UploadedFile> {
  const form = new FormData();
  form.append("file", file);
  form.append("context", "material");
  const xhr = await send("POST", `${API_BASE}/api/files/upload`, form, { signal, credentials: true, onProgress: (loaded) => onProgress(Math.min(loaded / file.size, 1)) });
  let body: { id?: string; name?: string; size?: number; mimeType?: string; error?: string } | null = null;
  try {
    body = JSON.parse(xhr.responseText);
  } catch {
    body = null;
  }
  if (xhr.status < 200 || xhr.status >= 300 || !body?.id) throw new UploadError(body?.error ?? "UPLOAD_FAILED");
  return { fileId: body.id, name: body.name ?? file.name, size: body.size ?? file.size, mimeType: body.mimeType ?? "" };
}

async function direct(file: File, kind: MaterialKind, api: DirectUploadApi, signal: AbortSignal, onProgress: (fraction: number) => void): Promise<UploadedFile> {
  const session = await api.start({ fileName: file.name, sizeBytes: file.size, kind });
  const stop = () => void api.abort({ sessionId: session.sessionId }).catch(() => undefined);
  try {
    const put = async (url: string, blob: Blob, report: (loaded: number) => void) => {
      const xhr = await send("PUT", url, blob, { signal, headers: { "Content-Type": session.contentType }, onProgress: report });
      if (xhr.status < 200 || xhr.status >= 300) throw new UploadError("UPLOAD_FAILED");
    };
    if (session.mode === "single" && session.url) {
      await put(session.url, file, (loaded) => onProgress(Math.min(loaded / file.size, 1)));
    } else {
      const partSize = session.partSize!;
      const loaded = new Map<number, number>();
      const report = () => onProgress(Math.min([...loaded.values()].reduce((a, b) => a + b, 0) / file.size, 1));
      const queue = Array.from({ length: session.partCount }, (_, i) => i + 1);
      const urls = new Map<number, string>();
      const urlFor = async (n: number) => {
        if (!urls.has(n)) {
          const batch = queue.filter((p) => p >= n && !urls.has(p)).slice(0, PART_URL_BATCH);
          for (const u of await api.partUrls({ sessionId: session.sessionId, partNumbers: batch.length ? batch : [n] })) urls.set(u.partNumber, u.url);
        }
        const url = urls.get(n);
        if (!url) throw new UploadError("UPLOAD_FAILED");
        return url;
      };
      let next = 0;
      const worker = async () => {
        while (next < queue.length) {
          const n = queue[next++];
          const blob = file.slice((n - 1) * partSize, Math.min(n * partSize, file.size));
          await put(await urlFor(n), blob, (l) => {
            loaded.set(n, l);
            report();
          });
          loaded.set(n, blob.size);
          report();
        }
      };
      await Promise.all(Array.from({ length: Math.min(PARALLEL_PARTS, queue.length) }, worker));
    }
    if (signal.aborted) throw new UploadError("UPLOAD_CANCELLED");
    const saved = await api.complete({ sessionId: session.sessionId });
    return { fileId: saved.id, name: saved.name, size: saved.size, mimeType: saved.mimeType };
  } catch (error) {
    stop();
    throw error;
  }
}

/** Uploads one material file the best way available; throws UploadError (UPLOAD_CANCELLED when stopped). */
export async function uploadMaterialFile(
  file: File,
  kind: MaterialKind,
  config: UploadConfig,
  api: DirectUploadApi,
  opts: { signal: AbortSignal; onProgress: (fraction: number) => void },
): Promise<UploadedFile> {
  const problem = precheck(file, kind, config);
  if (problem) throw new UploadError(problem);
  if (config.direct && file.size > config.serverMaxBytes) {
    try {
      return await direct(file, kind, api, opts.signal, opts.onProgress);
    } catch (error) {
      if (error instanceof UploadError) throw error;
      throw new UploadError(error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "UPLOAD_FAILED");
    }
  }
  return viaServer(file, opts.signal, opts.onProgress);
}
