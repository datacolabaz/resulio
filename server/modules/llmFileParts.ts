import { isGeminiUrl } from "../_core/aiConfig";
import type { MessageContent } from "../_core/llm";

/**
 * How a file reaches the model as a message part. Shared by question import (importJobs.ts) and
 * the AI test generator's source-grounded generation (ai.ts) -- kept provider-neutral (no
 * dependency on either caller) so both can import it without a cycle between them.
 */

export type InputMode = "native" | "text";

/** How a PDF reaches the model: Gemini and OpenAI read PDFs, Manus takes file_url; others get the text. */
export function pdfInputMode(config: { source: "ai" | "manus" | null; baseUrl: string }, forced: "native" | "text" | ""): InputMode {
  if (forced) return forced;
  if (config.source === "manus" || isGeminiUrl(config.baseUrl)) return "native";
  try {
    return new URL(config.baseUrl).hostname === "api.openai.com" ? "native" : "text";
  } catch {
    return "text";
  }
}

export function filePart(mimeType: string, bytes: Uint8Array, fileName: string, config: { source: "ai" | "manus" | null; baseUrl: string }): MessageContent {
  const url = `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
  if (mimeType.startsWith("image/")) return { type: "image_url", image_url: { url, detail: "high" } };
  if (config.source === "manus") return { type: "file_url", file_url: { url, mime_type: "application/pdf" } };
  if (isGeminiUrl(config.baseUrl)) return { type: "image_url", image_url: { url } };
  return { type: "file", file: { filename: fileName, file_data: url } };
}
