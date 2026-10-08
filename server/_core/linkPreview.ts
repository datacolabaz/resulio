import { SITE } from "../../client/src/seo/config";
import { groupPageTitle } from "../../shared/groupLinks";
import { normalizeShareCode, syllabusPageTitle, syllabusSharePath } from "../../shared/syllabusJoin";
import { escapeHtml, publicAppUrl } from "./email";

/**
 * Link previews (WhatsApp, Telegram, Facebook, LinkedIn, X, iMessage) for shared links: a syllabus
 * (`/syllabus/<code>`) and group invitations (`/join/<code>`, `/g/<token>`, `/invite/<token>`).
 * Those crawlers do not run JavaScript, so the page's head is written on the server. Kept free of
 * database imports: the static frontend service bundles this file and gets previews from the API
 * over HTTP; the API serving the SPA itself looks them up directly.
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

/** Only what the public group join page already shows (name, Fənn + Sinif or İstiqamət + Səviyyə, teacher). */
export interface GroupLinkPreview {
  name: string;
  groupType: "SCHOOL" | "COURSE";
  subject: string;
  grade: string;
  level: string;
  teacherName: string;
}

/** `code`: the group's invite code (`/join/`); `link`: a single-use link (`/g/`); `email`: an e-mail invite (`/invite/`). */
export type GroupLinkKind = "code" | "link" | "email";

/** null = nothing to show for this key; a throw = could not tell. */
export type Lookup<T> = (key: string) => Promise<T | null>;
export type PreviewLookup = Lookup<SyllabusPreview>;
export type GroupPreviewLookup = (kind: GroupLinkKind, key: string) => Promise<GroupLinkPreview | null>;

export type Resolved<T> = { status: "FOUND"; code: string; preview: T } | { status: "NOT_FOUND"; code: string | null } | { status: "UNAVAILABLE"; code: string };
export type PreviewResult = Resolved<SyllabusPreview>;
export type Resolver<T> = (key: string | null) => Promise<Resolved<T>>;

export const PREVIEW_TIMEOUT_MS = 1500;
const PREVIEW_TTL_MS = 60_000;
const PREVIEW_CACHE_MAX = 500;

function pathSegment(urlPath: string, prefix: string): { segment: string | null } | null {
  const m = new RegExp(`^/${prefix}/([^/]+)/?$`).exec(urlPath);
  if (!m) return null;
  try {
    return { segment: decodeURIComponent(m[1]) };
  } catch {
    return { segment: null };
  }
}

/** The share code of a `/syllabus/<code>` path (any case), or null for every other path. */
export function syllabusPathCode(urlPath: string): { code: string | null } | null {
  const match = pathSegment(urlPath, "syllabus");
  return match && { code: match.segment === null ? null : normalizeShareCode(match.segment) };
}

/** Same formats the server accepts (groups.ts invite codes, groupInviteLinks.ts / groupEmailInvites.ts tokens). */
const GROUP_KEYS: Record<GroupLinkKind, { prefix: string; normalize: (s: string) => string | null }> = {
  code: { prefix: "join", normalize: (s) => (/^[A-Za-z0-9_-]{4,32}$/.test(s.trim()) ? s.trim().toUpperCase() : null) },
  link: { prefix: "g", normalize: (s) => (/^[A-Za-z0-9_-]{43}$/.test(s) ? s : null) },
  email: { prefix: "invite", normalize: (s) => (/^[A-Za-z0-9]{16,128}$/.test(s) ? s : null) },
};
export const GROUP_LINK_KINDS = Object.keys(GROUP_KEYS) as GroupLinkKind[];

export function normalizeGroupKey(kind: GroupLinkKind, raw: string): string | null {
  return GROUP_KEYS[kind].normalize(raw);
}

/** The kind and key of a group invitation path, or null for every other path. */
export function groupPathKey(urlPath: string): { kind: GroupLinkKind; key: string | null } | null {
  for (const kind of GROUP_LINK_KINDS) {
    const match = pathSegment(urlPath, GROUP_KEYS[kind].prefix);
    if (match) return { kind, key: match.segment === null ? null : normalizeGroupKey(kind, match.segment) };
  }
  return null;
}

/** Paths whose HTML gets a link-preview head (and `noindex`). */
export const isLinkPreviewPath = (urlPath: string) => !!syllabusPathCode(urlPath) || !!groupPathKey(urlPath);

const oneLine = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
const sentences = (parts: string[]) =>
  `${parts
    .filter(Boolean)
    .map((s) => s.replace(/[.\s]+$/, ""))
    .join(". ")}.`;

type Text = { title: string; description: string };

const SYLLABUS_NOT_FOUND: Text = { title: "Syllabus link — Resulio", description: "Bu link aktiv deyil və ya tapılmadı." };
const SYLLABUS_UNAVAILABLE: Text = { title: "Syllabus — Resulio", description: "Resulio-da paylaşılan kurs proqramı. Proqrama baxmaq və qoşulma sorğusu göndərmək üçün linki açın." };
const GROUP_NOT_FOUND: Text = { title: "Qrup linki — Resulio", description: "Bu link aktiv deyil və ya tapılmadı." };
const GROUP_UNAVAILABLE: Text = { title: "Qrup dəvəti — Resulio", description: "Resulio-da qrupa dəvət. Qrupa qoşulmaq üçün linkə daxil olun." };

/** "AI Engineering · 9 modul · 9 ay. Müəllim: X. Proqrama baxın və qoşulma sorğusu göndərin." (Azerbaijani: public link audience). */
export function syllabusPreviewText(p: SyllabusPreview): Text {
  const duration = p.duration ? `${p.duration.value} ${p.duration.unit === "MONTHS" ? "ay" : "həftə"}` : oneLine(p.durationLabel, 64);
  const facts = [oneLine(p.subject, 80), p.moduleCount > 0 ? `${p.moduleCount} modul` : "", duration].filter(Boolean).join(" · ");
  const teacher = oneLine(p.teacherName, 80);
  return {
    title: syllabusPageTitle(oneLine(p.title, 100)),
    description: sentences([facts, teacher && `Müəllim: ${teacher}`, "Proqrama baxın və qoşulma sorğusu göndərin"]),
  };
}

/** Azerbaijani labels of GROUP_LEVELS (catalog `groups.level.*`); a level the teacher typed is shown as typed. */
export const GROUP_LEVEL_AZ: Record<string, string> = { BEGINNER: "Başlanğıc", INTERMEDIATE: "Orta", ADVANCED: "İrəli", PROFESSIONAL: "Peşəkar" };

/** "İstiqamət: AI Engineering · Səviyyə: Başlanğıc. Müəllim: X. Qrupa qoşulmaq üçün linkə daxil olun." — the join page's facts. */
export function groupPreviewText(p: GroupLinkPreview): Text {
  const level = oneLine(GROUP_LEVEL_AZ[p.level] ?? p.level, 60);
  const facts = (
    p.groupType === "SCHOOL"
      ? [["Fənn", oneLine(p.subject, 80)], ["Sinif", oneLine(p.grade, 40)]]
      : [["İstiqamət", oneLine(p.subject, 80)], ["Səviyyə", level]]
  )
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
  const teacher = oneLine(p.teacherName, 80);
  return { title: groupPageTitle(oneLine(p.name, 100)), description: sentences([facts, teacher && `Müəllim: ${teacher}`, "Qrupa qoşulmaq üçün linkə daxil olun"]) };
}

/** Head tags for a preview text; every value is HTML-escaped (titles and names are teacher-controlled). */
export function previewHead(text: Text, url: string | null, origin = publicAppUrl()) {
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
    ...(url ? [`<meta property="og:url" content="${escapeHtml(`${origin}${url}`)}" />`] : []),
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
export type PreviewHead = ReturnType<typeof previewHead>;

export function syllabusPreviewHead(result: PreviewResult, origin = publicAppUrl()): PreviewHead {
  const text = result.status === "FOUND" ? syllabusPreviewText(result.preview) : result.status === "NOT_FOUND" ? SYLLABUS_NOT_FOUND : SYLLABUS_UNAVAILABLE;
  return previewHead(text, result.code ? syllabusSharePath(result.code) : null, origin);
}

/** og:url only for the group's own invite code; secret tokens (`/g/`, `/invite/`) are not repeated in the page. */
export function groupPreviewHead(kind: GroupLinkKind, result: Resolved<GroupLinkPreview>, origin = publicAppUrl()): PreviewHead {
  const text = result.status === "FOUND" ? groupPreviewText(result.preview) : result.status === "NOT_FOUND" ? GROUP_NOT_FOUND : GROUP_UNAVAILABLE;
  return previewHead(text, kind === "code" && result.code ? `/join/${encodeURIComponent(result.code)}` : null, origin);
}

/**
 * The SPA shell with the preview's title and tags in place of its generic ones, or null when the
 * shell's markers are missing (the caller then serves the shell unchanged).
 */
export function injectPreviewHead(shell: string, head: PreviewHead): string | null {
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
export function previewResolver<T>(lookup: Lookup<T>, opts: { timeoutMs?: number; ttlMs?: number; max?: number } = {}): Resolver<T> {
  const { timeoutMs = PREVIEW_TIMEOUT_MS, ttlMs = PREVIEW_TTL_MS, max = PREVIEW_CACHE_MAX } = opts;
  const cache = new Map<string, { at: number; preview: T | null }>();
  return async (code) => {
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
      console.warn("[LinkPreview] lookup failed:", error instanceof Error ? error.message : error);
      return { status: "UNAVAILABLE", code };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Without a source a valid key cannot be checked: a neutral card, not "not found". */
const unconfigured = async <T>(code: string | null): Promise<Resolved<T>> => (code ? { status: "UNAVAILABLE", code } : { status: "NOT_FOUND", code: null });

export interface PreviewSources {
  syllabusPreview?: PreviewLookup;
  groupPreview?: GroupPreviewLookup;
}

/** Resolvers per link type, each with its own timeout and cache. */
export function previewResolvers(sources: PreviewSources, opts?: Parameters<typeof previewResolver>[1]) {
  const syllabus: Resolver<SyllabusPreview> = sources.syllabusPreview ? previewResolver(sources.syllabusPreview, opts) : unconfigured;
  const group = Object.fromEntries(
    GROUP_LINK_KINDS.map((kind) => {
      const source = sources.groupPreview;
      return [kind, source ? previewResolver<GroupLinkPreview>((key) => source(kind, key), opts) : unconfigured];
    }),
  ) as Record<GroupLinkKind, Resolver<GroupLinkPreview>>;
  return { syllabus, group };
}
export type PreviewResolvers = ReturnType<typeof previewResolvers>;

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** A syllabus preview from untrusted JSON (the API's answer), or null when it is not one. */
export function parsePreview(raw: unknown): SyllabusPreview | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const d = r.duration as Record<string, unknown> | null | undefined;
  const unit = d?.unit === "WEEKS" ? "WEEKS" : d?.unit === "MONTHS" ? "MONTHS" : null;
  const duration: SyllabusPreview["duration"] = unit && typeof d?.value === "number" && Number.isFinite(d.value) && d.value > 0 ? { value: d.value, unit } : null;
  const moduleCount = typeof r.moduleCount === "number" && Number.isInteger(r.moduleCount) && r.moduleCount >= 0 ? r.moduleCount : 0;
  return { title: str(r.title, 255), subject: str(r.subject, 255), moduleCount, duration, durationLabel: str(r.durationLabel, 255), teacherName: str(r.teacherName, 255) };
}

/** A group preview from untrusted JSON, or null when it is not one. */
export function parseGroupPreview(raw: unknown): GroupLinkPreview | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return {
    name: str(r.name, 255),
    groupType: r.groupType === "SCHOOL" ? "SCHOOL" : "COURSE",
    subject: str(r.subject, 255),
    grade: str(r.grade, 255),
    level: str(r.level, 255),
    teacherName: str(r.teacherName, 255),
  };
}

async function fetchPreview(url: string, timeoutMs: number): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`preview API answered ${res.status}`);
  return ((await res.json()) as { preview?: unknown }).preview ?? null;
}

/** The frontend service's syllabus lookup: `GET /api/public/syllabus-preview/<code>` on the API. */
export function httpPreviewLookup(apiUrl: string, timeoutMs = PREVIEW_TIMEOUT_MS): PreviewLookup {
  const base = apiUrl.replace(/\/+$/, "");
  return async (code) => {
    const preview = await fetchPreview(`${base}/api/public/syllabus-preview/${encodeURIComponent(code)}`, timeoutMs);
    return preview ? parsePreview(preview) : null;
  };
}

/** The frontend service's group lookup: `GET /api/public/group-preview/<kind>/<key>` on the API. */
export function httpGroupPreviewLookup(apiUrl: string, timeoutMs = PREVIEW_TIMEOUT_MS): GroupPreviewLookup {
  const base = apiUrl.replace(/\/+$/, "");
  return async (kind, key) => {
    const preview = await fetchPreview(`${base}/api/public/group-preview/${kind}/${encodeURIComponent(key)}`, timeoutMs);
    return preview ? parseGroupPreview(preview) : null;
  };
}

/** The SPA shell for a shared-link request with its preview head, or null for any other path. */
export async function linkPreviewHtml(shell: string, urlPath: string, resolvers: PreviewResolvers): Promise<string | null> {
  const syllabus = syllabusPathCode(urlPath);
  if (syllabus) return injectPreviewHead(shell, syllabusPreviewHead(await resolvers.syllabus(syllabus.code)));
  const group = groupPathKey(urlPath);
  if (group) return injectPreviewHead(shell, groupPreviewHead(group.kind, await resolvers.group[group.kind](group.key)));
  return null;
}
