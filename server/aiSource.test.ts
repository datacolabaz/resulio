import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { sourceMaterialFromFile } from "./modules/ai";
import { AppError } from "./modules/errors";

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
});
