import type { Express, Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: null as { id: number } | null,
  access: "ALLOWED" as "OPEN" | "ALLOWED" | "DENIED" | "SIGN_IN_REQUIRED",
  stored: null as unknown,
}));

vi.mock("./_core/sdk", () => ({
  sdk: { authenticateRequest: vi.fn(async () => (mocks.user ? { user: mocks.user } : Promise.reject(new Error("no session")))) },
}));
vi.mock("./modules/files", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/files")>()),
  fileRow: vi.fn(async (id: string) => (id === "f1" ? { id: "f1", fileName: "Plan.pdf", mimeType: "application/pdf", dataBase64: Buffer.from("db-bytes").toString("base64") } : null)),
  downloadAccess: vi.fn(async () => mocks.access),
  recordDownload: vi.fn(async () => undefined),
  recordShareDownload: vi.fn(async () => undefined),
  storedObjectOf: vi.fn(async () => mocks.stored),
}));

const { registerFileRoutes } = await import("./_core/files");
const filesModule = await import("./modules/files");

type Handler = (req: Request, res: Response) => Promise<void>;
let download!: Handler;
registerFileRoutes({ post: () => undefined, get: (_path: string, handler: Handler) => void (download = handler) } as unknown as Express);

function call(id: string) {
  const out: { status: number; body?: unknown; headers: Record<string, string>; redirect?: string; sent?: Buffer } = { status: 200, headers: {} };
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
    },
    setHeader(name: string, value: string) {
      out.headers[name] = value;
    },
    redirect(code: number, url: string) {
      out.status = code;
      out.redirect = url;
    },
    send(body: Buffer) {
      out.sent = body;
    },
  };
  return download({ params: { id }, query: {}, ip: "10.0.0.1", headers: {} } as unknown as Request, res as unknown as Response).then(() => out);
}

const r2Object = (publicUrl: string | null = null) => ({
  key: "files/ws/f1.pdf",
  store: {
    publicUrl: vi.fn(() => publicUrl),
    signedGetUrl: vi.fn(async () => "https://acc.r2.cloudflarestorage.com/signed"),
    get: vi.fn(async () => Buffer.from("r2-bytes")),
  },
});

describe("file download with R2", () => {
  beforeEach(() => {
    mocks.user = { id: 5 };
    mocks.access = "ALLOWED";
    mocks.stored = null;
    vi.mocked(filesModule.storedObjectOf).mockClear();
  });
  afterEach(() => vi.unstubAllEnvs());

  it("checks access before looking up the object", async () => {
    mocks.access = "DENIED";
    mocks.stored = r2Object();
    const out = await call("f1");
    expect(out.status).toBe(403);
    expect(out.redirect).toBeUndefined();
    expect(filesModule.storedObjectOf).not.toHaveBeenCalled();

    mocks.user = null;
    mocks.access = "SIGN_IN_REQUIRED";
    expect((await call("f1")).status).toBe(401);
  });

  it("redirects an allowed private download to a signed URL, never the public one", async () => {
    const stored = r2Object("https://cdn.example/files/ws/f1.pdf");
    mocks.stored = stored;
    const out = await call("f1");
    expect(out).toMatchObject({ status: 302, redirect: "https://acc.r2.cloudflarestorage.com/signed" });
    expect(out.headers["Cache-Control"]).toBe("no-store");
    expect(stored.store.signedGetUrl).toHaveBeenCalledWith("files/ws/f1.pdf", { fileName: "Plan.pdf", contentType: "application/pdf" });
  });

  it("uses the public URL only for files anyone may open", async () => {
    mocks.access = "OPEN";
    mocks.stored = r2Object("https://cdn.example/files/ws/f1.pdf");
    expect((await call("f1")).redirect).toBe("https://cdn.example/files/ws/f1.pdf");
  });

  it("streams through the API in proxy mode", async () => {
    vi.stubEnv("R2_DOWNLOAD_MODE", "proxy");
    mocks.stored = r2Object();
    const out = await call("f1");
    expect(out.sent?.toString()).toBe("r2-bytes");
    expect(out.headers["Content-Disposition"]).toContain('filename="Plan.pdf"');
  });

  it("serves files still in MySQL as before", async () => {
    const out = await call("f1");
    expect(out.sent?.toString()).toBe("db-bytes");
    expect((await call("nope")).status).toBe(404);
  });
});
