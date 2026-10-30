import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aiGenerateErrorOf, combineSourceMaterials, parseTaskTextOutput, sourceMaterialFromFile, type SourceMaterial } from "./modules/ai";
import { AppError } from "./modules/errors";
import { LlmHttpError } from "./_core/llm";

/**
 * `sourceMaterialFromFile` is the extension-dispatch core behind the AI test generator's
 * source-grounded mode (Mərhələ 3/4, point A of the approved plan): given an uploaded file's
 * bytes, decide how the model gets to read it, and refuse cleanly rather than silently sending
 * nothing when a file can't be read. Covers the text-extraction path directly (no DB needed, since
 * this function takes bytes rather than a fileId); the image/PDF-native branches just delegate to
 * `filePart`/`pdfInputMode` from llmFileParts.ts, which questionImport.test.ts already covers.
 */
describe("sourceMaterialFromFile", () => {
  it("extracts a .txt file verbatim", async () => {
    const r = await sourceMaterialFromFile("notes.txt", Buffer.from("Fotosintez bitkilərdə işıq enerjisini kimyəvi enerjiyə çevirir.", "utf8"));
    expect(r).toEqual({ kind: "text", text: "Fotosintez bitkilərdə işıq enerjisini kimyəvi enerjiyə çevirir." });
  });

  it("extracts a .csv file as a rendered table", async () => {
    const r = await sourceMaterialFromFile("data.csv", Buffer.from("topic,fact\nMars,Fourth planet from the sun\n", "utf8"));
    expect(r.kind).toBe("text");
    if (r.kind === "text") {
      expect(r.text).toContain("Mars");
      expect(r.text).toContain("Fourth planet");
    }
  });

  it("truncates long material to the character cap", async () => {
    const r = await sourceMaterialFromFile("long.txt", Buffer.from("x".repeat(30_000), "utf8"));
    expect(r.kind).toBe("text");
    if (r.kind === "text") expect(r.text.length).toBe(20_000);
  });

  it("rejects an empty .txt file as unreadable rather than silently grounding on nothing", async () => {
    await expect(sourceMaterialFromFile("empty.txt", Buffer.from("   \n  ", "utf8"))).rejects.toThrow(expect.objectContaining({ code: "AI_SOURCE_UNREADABLE" } as Partial<AppError>));
  });

  it("rejects an unsupported extension (legacy .doc) rather than guessing at its content", async () => {
    await expect(sourceMaterialFromFile("old.doc", Buffer.from("whatever"))).rejects.toThrow(expect.objectContaining({ code: "AI_SOURCE_FILE_TYPE" } as Partial<AppError>));
  });

  it("builds an image message part for a .png, without reading it as text", async () => {
    const r = await sourceMaterialFromFile("diagram.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(r.kind).toBe("parts");
    if (r.kind === "parts") {
      expect(r.parts).toHaveLength(1);
      expect(r.parts[0]).toMatchObject({ type: "image_url" });
    }
  });

  it("rejects a PDF with no extractable text (e.g. a blank or scanned page) as unreadable", async () => {
    const doc = await PDFDocument.create();
    doc.addPage();
    const bytes = await doc.save();
    await expect(sourceMaterialFromFile("blank.pdf", Buffer.from(bytes))).rejects.toThrow(expect.objectContaining({ code: "AI_SOURCE_UNREADABLE" } as Partial<AppError>));
  });

  it("extracts text from a PDF that has real text content", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage();
    page.drawText("Mars dördüncü planetdir.", { x: 50, y: 700, size: 14, font });
    const bytes = await doc.save();
    const r = await sourceMaterialFromFile("mars.pdf", Buffer.from(bytes));
    // Falls back to text mode when no AI provider is configured in this test environment (see
    // llmFileParts.pdfInputMode) -- a native PDF part would be `kind: "parts"` instead.
    expect(r.kind).toBe("text");
    if (r.kind === "text") expect(r.text).toContain("Mars");
  });

  describe("with Gemini configured as the AI provider (AI_API_URL pointed at Gemini's OpenAI-compat endpoint)", () => {
    // Gemini's OpenAI-compatibility endpoint has no documented support for a PDF file part --
    // `filePart` sends it as an `image_url` data: URI, an unconfirmed community workaround that
    // fails unpredictably (see the comment in modules/ai.ts). These tests pin down the fix: for a
    // PDF with a real text layer, Gemini must still get our own reliable text extraction, not the
    // risky native workaround -- while a genuinely textless (scanned) PDF still falls back to it
    // as a last resort, rather than failing outright.
    const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai";
    let prevUrl: string | undefined;
    let prevKey: string | undefined;

    beforeEach(() => {
      prevUrl = process.env.AI_API_URL;
      prevKey = process.env.AI_API_KEY;
      process.env.AI_API_URL = GEMINI_URL;
      process.env.AI_API_KEY = "test-key";
    });

    afterEach(() => {
      if (prevUrl === undefined) delete process.env.AI_API_URL;
      else process.env.AI_API_URL = prevUrl;
      if (prevKey === undefined) delete process.env.AI_API_KEY;
      else process.env.AI_API_KEY = prevKey;
    });

    it("still extracts text directly for a PDF with a real text layer, instead of the unreliable native workaround", async () => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage();
      page.drawText("Mars dördüncü planetdir.", { x: 50, y: 700, size: 14, font });
      const bytes = await doc.save();
      const r = await sourceMaterialFromFile("mars.pdf", Buffer.from(bytes));
      expect(r.kind).toBe("text");
      if (r.kind === "text") expect(r.text).toContain("Mars");
    });

    it("falls back to the native image_url workaround for a textless (scanned) PDF, rather than throwing", async () => {
      const doc = await PDFDocument.create();
      doc.addPage();
      const bytes = await doc.save();
      const r = await sourceMaterialFromFile("blank.pdf", Buffer.from(bytes));
      expect(r.kind).toBe("parts");
      if (r.kind === "parts") {
        expect(r.parts).toHaveLength(1);
        expect(r.parts[0]).toMatchObject({ type: "image_url" });
      }
    });
  });
});

/**
 * `combineSourceMaterials` merges several per-file `sourceMaterialOf` results (one per photo in a
 * multi-shot phone capture, or several picked files) into the single `SourceMaterial` the rest of
 * ai.ts already knows how to spread into the model's message content -- pure logic, no DB/network.
 */
describe("combineSourceMaterials", () => {
  it("passes a single material through unchanged", () => {
    const m: SourceMaterial = { kind: "text", text: "Mars dördüncü planetdir." };
    expect(combineSourceMaterials([m])).toEqual(m);
  });

  it("joins several text materials into one text block, in order", () => {
    const r = combineSourceMaterials([
      { kind: "text", text: "Birinci səhifə." },
      { kind: "text", text: "İkinci səhifə." },
    ]);
    expect(r.kind).toBe("text");
    if (r.kind === "text") {
      expect(r.text.indexOf("Birinci")).toBeLessThan(r.text.indexOf("İkinci"));
    }
  });

  it("truncates the joined text to the shared character cap", () => {
    const r = combineSourceMaterials([
      { kind: "text", text: "x".repeat(15_000) },
      { kind: "text", text: "y".repeat(15_000) },
    ]);
    expect(r.kind).toBe("text");
    if (r.kind === "text") expect(r.text.length).toBe(20_000);
  });

  it("flattens text + image materials into one parts array, preserving order", () => {
    const r = combineSourceMaterials([
      { kind: "text", text: "Bağlı mətn." },
      { kind: "parts", parts: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] },
    ]);
    expect(r.kind).toBe("parts");
    if (r.kind === "parts") {
      expect(r.parts).toHaveLength(2);
      expect(r.parts[0]).toMatchObject({ type: "text", text: "Bağlı mətn." });
      expect(r.parts[1]).toMatchObject({ type: "image_url" });
    }
  });

  it("flattens several image materials (a multi-photo capture) into one parts array", () => {
    const photo = (n: number): SourceMaterial => ({ kind: "parts", parts: [{ type: "image_url", image_url: { url: `data:image/png;base64,${n}` } }] });
    const r = combineSourceMaterials([photo(1), photo(2), photo(3)]);
    expect(r.kind).toBe("parts");
    if (r.kind === "parts") expect(r.parts).toHaveLength(3);
  });
});

/**
 * `aiGenerateErrorOf` is what keeps a failed `invokeLLM` call (a bad key, a renamed model, a
 * quota hit, a transient network error) from reaching the client as the generic, unactionable
 * "unexpected error" fallback -- see the comment above its definition in modules/ai.ts. Each case
 * here mirrors a real provider response shape (Gemini answers a bad key with 400, not 401/403).
 */
describe("aiGenerateErrorOf", () => {
  it("maps a 401/403 (or Gemini's 400 'api key' body) to AI_KEY_INVALID", () => {
    expect(aiGenerateErrorOf(new LlmHttpError(401, "LLM invoke failed: 401 Unauthorized"))).toEqual(new AppError("AI_KEY_INVALID"));
    expect(aiGenerateErrorOf(new LlmHttpError(400, "LLM invoke failed: 400 – API key not valid"))).toEqual(new AppError("AI_KEY_INVALID"));
  });

  it("maps a 404 (or Gemini's 400 'model is not found' body) to AI_NOT_FOUND", () => {
    expect(aiGenerateErrorOf(new LlmHttpError(404, "LLM invoke failed: 404 Not Found"))).toEqual(new AppError("AI_NOT_FOUND"));
    expect(aiGenerateErrorOf(new LlmHttpError(400, "LLM invoke failed: 400 – models/gemini-3.8-flash is not found"))).toEqual(new AppError("AI_NOT_FOUND"));
  });

  it("maps a 429 to AI_QUOTA", () => {
    expect(aiGenerateErrorOf(new LlmHttpError(429, "LLM invoke failed: 429 Too Many Requests"))).toEqual(new AppError("AI_QUOTA"));
  });

  it("maps a generic/transient failure (5xx, network error, timeout) to AI_REQUEST_FAILED", () => {
    expect(aiGenerateErrorOf(new LlmHttpError(503, "LLM invoke failed: 503 Service Unavailable"))).toEqual(new AppError("AI_REQUEST_FAILED"));
    expect(aiGenerateErrorOf(new Error("fetch failed"))).toEqual(new AppError("AI_REQUEST_FAILED"));
  });
});

/**
 * `parseTaskTextOutput` turns the model's raw JSON reply into {title, description, instructions}
 * for `generateTaskText` -- see a teacher reporting the "Açıq sualların sayı" (open-question count)
 * flow coming back with title/description filled but "Təlimat" (instructions) completely empty
 * even though a count was requested. gpt-4o-mini was the provider in that report.
 */
describe("parseTaskTextOutput", () => {
  it("reads title/description/instructions straight through when the model replies as asked", () => {
    const content = JSON.stringify({ title: "Mars", description: "Planet haqqında", instructions: "1. Sual bir\n2. Sual iki" });
    expect(parseTaskTextOutput(content, 2)).toEqual({ title: "Mars", description: "Planet haqqında", instructions: "1. Sual bir\n2. Sual iki" });
  });

  it("joins instructions into a numbered-list string when the model sends an array of questions instead", () => {
    const content = JSON.stringify({ title: "Mars", description: "Planet haqqında", instructions: ["1. Sual bir", "2. Sual iki"] });
    expect(parseTaskTextOutput(content, 2)).toEqual({ title: "Mars", description: "Planet haqqında", instructions: "1. Sual bir\n2. Sual iki" });
  });

  it("falls back to an empty instructions string (not a crash) when the model omits the field entirely", () => {
    const content = JSON.stringify({ title: "Mars", description: "Planet haqqında" });
    expect(parseTaskTextOutput(content, 2)).toEqual({ title: "Mars", description: "Planet haqqında", instructions: "" });
  });

  it("returns an empty title (the caller then rejects it as AI_INVALID_OUTPUT) when the reply isn't usable JSON", () => {
    expect(parseTaskTextOutput("not json at all", undefined)).toEqual({ title: "", description: "", instructions: "" });
  });

  it("does not require instructions when no open-question count was requested (free-form assignment mode)", () => {
    const content = JSON.stringify({ title: "Mars", description: "Planet haqqında", instructions: "" });
    expect(parseTaskTextOutput(content, undefined)).toEqual({ title: "Mars", description: "Planet haqqında", instructions: "" });
  });
});
