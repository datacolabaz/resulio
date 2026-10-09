import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { files } from "../drizzle/schema";
import {
  contentDisposition,
  createR2Store,
  objectKeyFor,
  r2ConfigFromEnv,
  r2DownloadMode,
  SIGNED_URL_TTL_SECONDS,
  uploadBackend,
  type ObjectStore,
  type R2Config,
  type S3Like,
} from "./fileStorage/r2";
import { fileTypeGroup, FILE_TYPE_GROUPS, groupTotals } from "./fileStorage/summary";

const mocks = vi.hoisted(() => ({
  results: [] as unknown[][],
  selects: [] as Array<Record<string, unknown> | undefined>,
  inserts: [] as unknown[],
  updates: [] as unknown[],
}));

vi.mock("./db", () => {
  const chain = (result: () => unknown, onValues?: (v: unknown) => void): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") return (resolve: (v: unknown) => void) => resolve(result());
          if (prop === "as") return () => ({ fileId: { alias: true } });
          if ((prop === "values" || prop === "set") && onValues) return (v: unknown) => (onValues(v), chain(result));
          return () => chain(result, onValues);
        },
      },
    );
  const next = () => mocks.results.shift() ?? [];
  return {
    requireDb: () => ({
      select: (fields?: Record<string, unknown>) => (mocks.selects.push(fields), chain(next)),
      selectDistinct: () => chain(() => []),
      insert: () => chain(() => undefined, (v) => mocks.inserts.push(v)),
      update: () => chain(() => undefined, (v) => mocks.updates.push(v)),
    }),
  };
});
vi.mock("./platformSettings", () => ({
  getPlatformSettings: async () => ({ "storage.softQuotaBytes": 5_000_000 }),
}));

const { storageSummary } = await import("./fileStorage/summary");
const { migrateFiles } = await import("./fileStorage/migrate");

const ENV = { R2_ACCOUNT_ID: "acc123", R2_ACCESS_KEY_ID: "AKID", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "resulio-files" };
const CONFIG: R2Config = { accountId: "acc123", accessKeyId: "AKID", secretAccessKey: "secret", bucket: "resulio-files", publicBaseUrl: "", endpoint: "https://acc123.r2.cloudflarestorage.com" };

describe("R2 configuration", () => {
  it("is off unless all four variables are set", () => {
    expect(r2ConfigFromEnv({})).toBeNull();
    expect(r2ConfigFromEnv({ ...ENV, R2_BUCKET: " " })).toBeNull();
    expect(r2ConfigFromEnv(ENV)).toEqual(CONFIG);
  });

  it("strips quotes and trailing slashes and honours an endpoint override", () => {
    const c = r2ConfigFromEnv({ ...ENV, R2_BUCKET: '"resulio-files"', R2_PUBLIC_BASE_URL: "https://files.resulio.az/", R2_ENDPOINT: "http://localhost:9000" });
    expect(c).toMatchObject({ bucket: "resulio-files", publicBaseUrl: "https://files.resulio.az", endpoint: "http://localhost:9000" });
  });

  it("sends new uploads to R2 only when configured and not pinned to the database", () => {
    expect(uploadBackend({})).toBe("db");
    expect(uploadBackend(ENV)).toBe("r2");
    expect(uploadBackend({ ...ENV, FILE_STORAGE_BACKEND: "db" })).toBe("db");
    expect(r2DownloadMode({})).toBe("redirect");
    expect(r2DownloadMode({ R2_DOWNLOAD_MODE: "PROXY" })).toBe("proxy");
  });

  it("keys objects by workspace and file id, keeping a safe extension", () => {
    expect(objectKeyFor({ id: "f1", workspaceId: "ws9", fileName: "Mühazirə 1.PDF" })).toBe("files/ws9/f1.pdf");
    expect(objectKeyFor({ id: "f2", workspaceId: "ws9", fileName: "README" })).toBe("files/ws9/f2");
  });

  it("builds an attachment header with an ASCII fallback", () => {
    expect(contentDisposition('Şəkil "1".png')).toBe(`attachment; filename="__kil '1'.png"; filename*=UTF-8''${encodeURIComponent('Şəkil "1".png')}`);
  });
});

describe("R2 driver", () => {
  const fake = () => {
    const sent: unknown[] = [];
    const objects = new Map<string, Buffer>();
    const client: S3Like = {
      async send(command) {
        sent.push(command);
        const input = (command as { input: { Key: string; Body?: Buffer } }).input;
        if (command instanceof PutObjectCommand) objects.set(input.Key, input.Body as Buffer);
        if (command instanceof GetObjectCommand) {
          const body = objects.get(input.Key);
          return { Body: body && { transformToByteArray: async () => new Uint8Array(body) } };
        }
        if (command instanceof HeadObjectCommand) {
          const body = objects.get(input.Key);
          if (!body) throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
          return { ContentLength: body.byteLength };
        }
        if (command instanceof DeleteObjectCommand) objects.delete(input.Key);
        return {};
      },
    };
    return { client, sent, objects };
  };

  it("puts, reads, sizes and deletes objects in the configured bucket", async () => {
    const { client, sent } = fake();
    const store = createR2Store(CONFIG, client);
    await store.put("files/ws/a.pdf", Buffer.from("hello"), "application/pdf");
    const put = sent[0] as PutObjectCommand;
    expect(put.input).toMatchObject({ Bucket: "resulio-files", Key: "files/ws/a.pdf", ContentType: "application/pdf", ContentLength: 5 });
    expect((await store.get("files/ws/a.pdf")).toString()).toBe("hello");
    expect(await store.head("files/ws/a.pdf")).toBe(5);
    await store.remove("files/ws/a.pdf");
    expect(await store.head("files/ws/a.pdf")).toBeNull();
  });

  it("rethrows errors other than not-found from head", async () => {
    const store = createR2Store(CONFIG, { send: async () => Promise.reject(Object.assign(new Error("denied"), { $metadata: { httpStatusCode: 403 } })) });
    await expect(store.head("k")).rejects.toThrow("denied");
  });

  it("signs short-lived download URLs that keep the file name", async () => {
    const presign = vi.fn(async (_c: S3Like, command: GetObjectCommand, opts: { expiresIn: number }) => `https://signed/${command.input.Key}?ttl=${opts.expiresIn}`);
    const store = createR2Store(CONFIG, fake().client, presign);
    const url = await store.signedGetUrl("files/ws/a.pdf", { fileName: "Plan.pdf", contentType: "application/pdf" });
    expect(url).toBe(`https://signed/files/ws/a.pdf?ttl=${SIGNED_URL_TTL_SECONDS}`);
    const command = presign.mock.calls[0][1];
    expect(command.input).toMatchObject({ Bucket: "resulio-files", ResponseContentType: "application/pdf", ResponseContentDisposition: contentDisposition("Plan.pdf") });
  });

  it("only offers public URLs when a public base is configured", () => {
    expect(createR2Store(CONFIG, fake().client).publicUrl("files/ws/a b.pdf")).toBeNull();
    expect(createR2Store({ ...CONFIG, publicBaseUrl: "https://cdn.x" }, fake().client).publicUrl("files/ws/a b.pdf")).toBe("https://cdn.x/files/ws/a%20b.pdf");
  });
});

describe("storage summary", () => {
  beforeEach(() => {
    mocks.results = [];
    mocks.selects = [];
    mocks.inserts = [];
    mocks.updates = [];
  });

  it("groups MIME types into a fixed order and drops empty groups", () => {
    expect(fileTypeGroup("application/pdf")).toBe("PDF");
    expect(fileTypeGroup("image/png")).toBe("IMAGE");
    expect(fileTypeGroup("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("DOCUMENT");
    expect(fileTypeGroup("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")).toBe("SPREADSHEET");
    expect(fileTypeGroup("text/csv")).toBe("SPREADSHEET");
    expect(fileTypeGroup("application/vnd.ms-powerpoint")).toBe("PRESENTATION");
    expect(fileTypeGroup("text/plain")).toBe("TEXT");
    expect(fileTypeGroup("application/zip")).toBe("OTHER");
    expect(
      groupTotals(
        [
          { key: "IMAGE", count: 1, bytes: 10 },
          { key: "PDF", count: 2, bytes: 5 },
          { key: "IMAGE", count: 3, bytes: 30 },
        ],
        FILE_TYPE_GROUPS,
      ),
    ).toEqual([
      { key: "PDF", count: 2, bytes: 5 },
      { key: "IMAGE", count: 4, bytes: 40 },
    ]);
  });

  it("adds up totals, the database / R2 split and the groups, without reading file contents", async () => {
    mocks.results = [
      [{ count: 5, bytes: "3000" }], // all files
      [{ count: 2, bytes: 1000 }], // in R2
      [
        { mimeType: "application/pdf", count: 3, bytes: 2000 },
        { mimeType: "image/jpeg", count: 1, bytes: 600 },
        { mimeType: "image/png", count: 1, bytes: 400 },
      ],
      [
        { key: "MATERIAL", count: 2, bytes: 1500 },
        { key: "STUDENT_SUBMISSION", count: 3, bytes: 1500 },
      ],
      [{ userId: 7, name: "T", email: "t@x", count: 5, bytes: 3000 }],
      [{ id: "f1", fileName: "big.pdf", mimeType: "application/pdf", sizeBytes: 1800, createdAt: new Date(), workspaceTitle: "W", uploaderName: "T", inObjectStore: 1 }],
    ];
    const s = await storageSummary();
    expect(s.totalFiles).toBe(5);
    expect(s.totalBytes).toBe(3000);
    expect(s.softQuotaBytes).toBe(5_000_000);
    expect(s.backend.inDatabase).toEqual({ count: 3, bytes: 2000 });
    expect(s.backend.inObjectStore).toEqual({ count: 2, bytes: 1000 });
    expect(s.byType).toEqual([
      { key: "PDF", count: 3, bytes: 2000 },
      { key: "IMAGE", count: 2, bytes: 1000 },
    ]);
    expect(s.byFeature.map((g) => g.key)).toEqual(["MATERIAL", "STUDENT_SUBMISSION"]);
    expect(s.largest[0].inObjectStore).toBe(true);
    const selected = mocks.selects.flatMap((f) => Object.values(f ?? {}));
    expect(selected).not.toContain(files.dataBase64);
  });
});

describe("moving files to R2", () => {
  const store = (sizes: Map<string, number | null>, failPut = false): ObjectStore & { put: ReturnType<typeof vi.fn> } => ({
    backend: "r2",
    bucket: "resulio-files",
    put: vi.fn(async (key: string, body: Buffer) => {
      if (failPut) throw new Error("network");
      if (!sizes.has(key)) sizes.set(key, body.byteLength);
    }),
    get: vi.fn(),
    head: vi.fn(async (key: string) => sizes.get(key) ?? null),
    remove: vi.fn(),
    signedGetUrl: vi.fn(),
    publicUrl: () => null,
  });
  const file = { id: "f1", workspaceId: "ws", fileName: "a.pdf", mimeType: "application/pdf", sizeBytes: 5 };
  const quiet = () => undefined;

  beforeEach(() => {
    mocks.results = [];
    mocks.inserts = [];
    mocks.updates = [];
  });

  it("only reports in a dry run", async () => {
    mocks.results = [[file], []];
    const s = store(new Map());
    const report = await migrateFiles({ store: s, mode: "copy", apply: false, log: quiet });
    expect(report).toMatchObject({ candidates: 1, bytes: 5, done: 0, failed: [] });
    expect(s.put).not.toHaveBeenCalled();
    expect(mocks.inserts).toEqual([]);
  });

  it("copies, verifies the size and records the object, keeping the MySQL copy", async () => {
    mocks.results = [[file], [{ data: Buffer.from("hello").toString("base64") }], []];
    const report = await migrateFiles({ store: store(new Map()), mode: "copy", apply: true, log: quiet });
    expect(report.done).toBe(1);
    expect(mocks.inserts).toEqual([expect.objectContaining({ fileId: "f1", bucket: "resulio-files", objectKey: "files/ws/f1.pdf", sizeBytes: 5 })]);
    expect(mocks.updates).toEqual([]);
  });

  it("does not record a copy whose stored size is wrong", async () => {
    mocks.results = [[file], [{ data: Buffer.from("hello").toString("base64") }], []];
    const report = await migrateFiles({ store: store(new Map([["files/ws/f1.pdf", 3]])), mode: "copy", apply: true, log: quiet });
    expect(report.failed).toHaveLength(1);
    expect(mocks.inserts).toEqual([]);
  });

  it("purges the MySQL copy only when the object is confirmed", async () => {
    mocks.results = [[{ ...file, objectKey: "files/ws/f1.pdf" }, { ...file, id: "f2", objectKey: "files/ws/f2.pdf" }], []];
    const report = await migrateFiles({ store: store(new Map([["files/ws/f1.pdf", 5]])), mode: "purge", apply: true, log: quiet });
    expect(report.done).toBe(1);
    expect(report.failed.map((f) => f.id)).toEqual(["f2"]);
    expect(mocks.updates).toEqual([{ dataBase64: "" }]);
  });
});
