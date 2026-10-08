import { SITE } from "../../client/src/seo/config";
import { normalizeShareCode, syllabusPageTitle, syllabusSharePath } from "../../shared/syllabusJoin";
import { escapeHtml, publicAppUrl } from "./email";

/**
 * Link previews (WhatsApp, Telegram, Facebook, LinkedIn, X, iMessage) for a shared syllabus
 * (`/syllabus/<code>`). Those crawlers do not run JavaScript, so the page's head is written on the
 * server. Kept free of database imports: the static frontend service bundles this file and gets the
 * preview from the API over HTTP; the API serving the SPA itself looks it up directly.
 */

/** Only what the public syllabus page already shows. */
export interface SyllabusPreview {
  title: string;
  subject: string;
  moduleCount: number;
  duration: { value: number; unit: "WEEKS" | "MONTHS" } | null;
  durationLabel: string;
  teacherName: string;
}

/** null = no such shareable syllabus; a throw = could not tell. */
export type PreviewLookup = (code: string) => Promise<SyllabusPreview | null>;

export type PreviewResult = { status: "FOUND"; code: string; preview: SyllabusPreview } | { status: "NOT_FOUND"; code: string | null } | { status: "UNAVAILABLE"; code: string };

export const PREVIEW_TIMEOUT_MS = 1500;
const PREVIEW_TTL_MS = 60_000;
const PREVIEW_CACHE_MAX = 500;

/** The share code of a `/syllabus/<code>` path (any case), or null for every other path. */
export function syllabusPathCode(urlPath: string): { code: string | null } | null {
  const m = /^\/syllabus\/([^/]+)\/?$/.exec(urlPath);
  if (!m) return null;
  let segment = m[1];
  try {
    segment = decodeURIComponent(segment);
  } catch {
    return { code: null };
  }
  return { code: normalizeShareCode(segment) };
}

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const sentence = (s: string) => s.replace(/[.\s]+$/, "");

const NOT_FOUND = { title: "Syllabus link — Resulio", description: "Bu link aktiv deyil və ya tapılmadı." };
const UNAVAILABLE = { title: "Syllabus — Resulio", description: "Resulio-da paylaşılan kurs proqramı. Proqrama baxmaq və qoşulma sorğusu göndərmək üçün linki açın." };

/** "AI Engineering · 9 modul · 9 ay. Müəllim: X. Proqrama baxın və qoşulma sorğusu göndərin." (Azerbaijani: public link audience). */
export function syllabusPreviewText(p: SyllabusPreview): { title: string; description: string } {
  const duration = p.duration ? `${p.duration.value} ${p.duration.unit === "MONTHS" ? "ay" : "həftə"}` : oneLine(p.durationLabel, 64);
  const facts = [oneLine(p.subject, 80), p.moduleCount > 0 ? `${p.moduleCount} modul` : "", duration].filter(Boolean).join(" · ");
  const teacher = oneLine(p.teacherName, 80);
  const description = [facts, teacher && `Müəllim: ${teacher}`, "Proqrama baxın və qoşulma sorğusu göndərin"]
    .filter(Boolean)
    .map(sentence)
    .join(". ");
  return { title: syllabusPageTitle(oneLine(p.title, 100)), description: `${description}.` };
}

/** Head tags for the result; every value is HTML-escaped (titles and names are teacher-controlled). */
export function syllabusPreviewHead(result: PreviewResult, origin = publicAppUrl()) {
  const text = result.status === "FOUND" ? syllabusPreviewText(result.preview) : result.status === "NOT_FOUND" ? NOT_FOUND : UNAVAILABLE;
  const title = escapeHtml(text.title);
  const description = escapeHtml(text.description);
  const image = SITE.ogImage ?? SITE.logo;
  const imageUrl = escapeHtml(`${origin}${image.path}`);
  const tags = [
    `<meta name="description" content="${description}" />`,
    `<meta name="robots" content="noindex, nofollow" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:locale" content="az_AZ" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    ...(result.code ? [`<meta property="og:url" content="${escapeHtml(`${origin}${syllabusSharePath(result.code)}`)}" />`] : []),
    `<meta property="og:image" content="${imageUrl}" />`,
    `<meta property="og:image:width" content="${image.width}" />`,
    `<meta property="og:image:height" content="${image.height}" />`,
    `<meta property="og:image:alt" content="${escapeHtml(SITE.name)}" />`,
    `<meta name="twitter:card" content="${SITE.ogImage ? "summary_large_image" : "summary"}" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    `<meta name="twitter:image" content="${imageUrl}" />`,
  ];
  return { title, tags };
}

/**
 * The SPA shell with the preview's title and tags in place of its generic ones, or null when the
 * shell's markers are missing (the caller then serves the shell unchanged).
 */
export function injectPreviewHead(shell: string, head: ReturnType<typeof syllabusPreviewHead>): string | null {
  const titleRe = /<title>[^<]*<\/title>/;
  const descriptionRe = /<meta name="description" content="[^"]*" \/>/;
  if (!titleRe.test(shell) || !descriptionRe.test(shell)) return null;
  const tags = shell.includes(`property="og:site_name"`) ? head.tags : [`<meta property="og:site_name" content="${escapeHtml(SITE.name)}" />`, ...head.tags];
  // Function replacers: a `$&` in a teacher's title must stay literal text.
  return shell.replace(titleRe, () => `<title>${head.title}</title>`).replace(descriptionRe, () => tags.join("\n    "));
}

/**
 * Wraps a lookup with a timeout (HTML serving never waits long or breaks) and a short cache of
 * answers (crawlers often fetch a link several times; errors are not cached).
 */
export function previewResolver(lookup: PreviewLookup, opts: { timeoutMs?: number; ttlMs?: number; max?: number } = {}) {
  const { timeoutMs = PREVIEW_TIMEOUT_MS, ttlMs = PREVIEW_TTL_MS, max = PREVIEW_CACHE_MAX } = opts;
  const cache = new Map<string, { at: number; preview: SyllabusPreview | null }>();
  return async (code: string | null): Promise<PreviewResult> => {
    if (!code) return { status: "NOT_FOUND", code: null };
    const hit = cache.get(code);
    if (hit && Date.now() - hit.at < ttlMs) return hit.preview ? { status: "FOUND", code, preview: hit.preview } : { status: "NOT_FOUND", code };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("preview lookup timed out")), timeoutMs);
      });
      const preview = await Promise.race([lookup(code), timeout]);
      cache.delete(code);
      if (cache.size >= max) cache.delete(cache.keys().next().value!);
      cache.set(code, { at: Date.now(), preview });
      return preview ? { status: "FOUND", code, preview } : { status: "NOT_FOUND", code };
    } catch (error) {
      console.warn("[LinkPreview] syllabus lookup failed:", error instanceof Error ? error.message : error);
      return { status: "UNAVAILABLE", code };
    } finally {
      clearTimeout(timer);
    }
  };
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** A preview from untrusted JSON (the API's answer), or null when it is not one. */
export function parsePreview(raw: unknown): SyllabusPreview | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const d = r.duration as Record<string, unknown> | null | undefined;
  const unit = d?.unit === "WEEKS" ? "WEEKS" : d?.unit === "MONTHS" ? "MONTHS" : null;
  const duration: SyllabusPreview["duration"] = unit && typeof d?.value === "number" && Number.isFinite(d.value) && d.value > 0 ? { value: d.value, unit } : null;
  const moduleCount = typeof r.moduleCount === "number" && Number.isInteger(r.moduleCount) && r.moduleCount >= 0 ? r.moduleCount : 0;
  return { title: str(r.title, 255), subject: str(r.subject, 255), moduleCount, duration, durationLabel: str(r.durationLabel, 255), teacherName: str(r.teacherName, 255) };
}

/** The frontend service's lookup: the API's public preview endpoint (`GET /api/public/syllabus-preview/<code>`). */
export function httpPreviewLookup(apiUrl: string, timeoutMs = PREVIEW_TIMEOUT_MS): PreviewLookup {
  const base = apiUrl.replace(/\/+$/, "");
  return async (code) => {
    const res = await fetch(`${base}/api/public/syllabus-preview/${encodeURIComponent(code)}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`preview API answered ${res.status}`);
    const body = (await res.json()) as { preview?: unknown };
    return body.preview ? parsePreview(body.preview) : null;
  };
}

/** The SPA shell for a `/syllabus/<code>` request with its preview head. */
export async function syllabusPreviewHtml(shell: string, urlPath: string, resolve: (code: string | null) => Promise<PreviewResult>): Promise<string | null> {
  const match = syllabusPathCode(urlPath);
  if (!match) return null;
  return injectPreviewHead(shell, syllabusPreviewHead(await resolve(match.code)));
}
