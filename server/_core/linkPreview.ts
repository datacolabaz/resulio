import { SITE } from "../../client/src/seo/config";
import { groupPageTitle } from "../../shared/groupLinks";
import { normalizeShareCode, syllabusPageTitle, syllabusSharePath } from "../../shared/syllabusJoin";
import { examPageTitle, materialPageTitle, normalizeTaskMaterialCode, taskPageTitle } from "../../shared/taskMaterialShare";
import { escapeHtml, publicAppUrl } from "./email";

/**
 * Link previews (WhatsApp, Telegram, Facebook, LinkedIn, X, iMessage) for shared links: a syllabus
 * (`/syllabus/<code>`), a task (`/task/<code>`), a material (`/material/<code>`), and group
 * invitations (`/join/<code>`, `/g/<token>`, `/invite/<token>`). Those crawlers do not run
 * JavaScript, so the page's head is written on the server. Kept free of database imports: the
 * static frontend service bundles this file and gets previews from the API over HTTP; the API
 * serving the SPA itself looks them up directly.
 *
 * A task/material preview intentionally shows its own title (and a short description) even for a
 * GROUPS-restricted task or a RECIPIENTS-only material that an anonymous crawler could not actually
 * open — same as the syllabus/group previews already do: naming what's behind the link isn't the
 * protected part, only its content (files, submissions, answer key, …) is, and that still goes
 * through the full access check in the tRPC `public.task`/`public.material` queries.
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

/** Only what the public task page already shows, before sign-in/access is checked — the task's name
 *  and own description are not the protected part of a share link, only its files/submission are. */
export interface TaskPreview {
  title: string;
  description: string;
  teacherName: string;
}

/** Only what the public material page already shows, same reasoning as TaskPreview. */
export interface MaterialPreview {
  title: string;
  description: string;
  subject: string;
  topic: string;
  teacherName: string;
}

/** Only what the public exam page already shows — unlike tasks, there is no sign-in gate on these
 *  facts at all; the public page shows them to anyone with the link, login is only needed to start it. */
export interface ExamPreview {
  title: string;
  description: string;
  subject: string;
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
export type TaskPreviewLookup = Lookup<TaskPreview>;
export type MaterialPreviewLookup = Lookup<MaterialPreview>;
export type ExamPreviewLookup = Lookup<ExamPreview>;
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

/** The share code of a `/task/<code>` path (any case), or null for every other path. */
export function taskPathCode(urlPath: string): { code: string | null } | null {
  const match = pathSegment(urlPath, "task");
  return match && { code: match.segment === null ? null : normalizeTaskMaterialCode(match.segment) };
}

/** The share code of a `/material/<code>` path (any case), or null for every other path. */
export function materialPathCode(urlPath: string): { code: string | null } | null {
  const match = pathSegment(urlPath, "material");
  return match && { code: match.segment === null ? null : normalizeTaskMaterialCode(match.segment) };
}

/** The share code of an `/exam/<code>` path (any case), or null for every other path. */
export function examPathCode(urlPath: string): { code: string | null } | null {
  const match = pathSegment(urlPath, "exam");
  return match && { code: match.segment === null ? null : normalizeTaskMaterialCode(match.segment) };
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
export const isLinkPreviewPath = (urlPath: string) =>
  !!syllabusPathCode(urlPath) || !!taskPathCode(urlPath) || !!materialPathCode(urlPath) || !!examPathCode(urlPath) || !!groupPathKey(urlPath);

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
const TASK_NOT_FOUND: Text = { title: "Tapşırıq linki — Resulio", description: "Bu link aktiv deyil və ya tapılmadı." };
const TASK_UNAVAILABLE: Text = { title: "Tapşırıq — Resulio", description: "Resulio-da paylaşılan tapşırıq. Təfərrüatlara baxmaq üçün linki açın." };
const MATERIAL_NOT_FOUND: Text = { title: "Material linki — Resulio", description: "Bu link aktiv deyil və ya tapılmadı." };
const MATERIAL_UNAVAILABLE: Text = { title: "Material — Resulio", description: "Resulio-da paylaşılan material. Təfərrüatlara baxmaq üçün linki açın." };
const EXAM_NOT_FOUND: Text = { title: "İmtahan linki — Resulio", description: "Bu link aktiv deyil və ya tapılmadı." };
const EXAM_UNAVAILABLE: Text = { title: "İmtahan — Resulio", description: "Resulio-da paylaşılan imtahan. Təfərrüatlara baxmaq üçün linki açın." };
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

/** "<description>. Müəllim: X. Tapşırığa baxın." — falls back to the teacher + CTA alone when the
 *  task has no description, same shape as the syllabus/group previews. This is the whole point of
 *  the fix: the task's OWN title/description, not the site-wide "Resulio — onlayn imtahan …" card. */
export function taskPreviewText(p: TaskPreview): Text {
  const teacher = oneLine(p.teacherName, 80);
  const desc = oneLine(p.description, 200);
  return {
    title: taskPageTitle(oneLine(p.title, 100)),
    description: sentences([desc, teacher && `Müəllim: ${teacher}`, "Tapşırığa baxın"]),
  };
}

/** Same shape as taskPreviewText; falls back to "Fənn: X · Mövzu: Y" facts when the material has no
 *  description of its own. */
export function materialPreviewText(p: MaterialPreview): Text {
  const teacher = oneLine(p.teacherName, 80);
  const desc = oneLine(p.description, 200);
  const facts = [p.subject && `Fənn: ${oneLine(p.subject, 60)}`, p.topic && `Mövzu: ${oneLine(p.topic, 60)}`].filter(Boolean).join(" · ");
  return {
    title: materialPageTitle(oneLine(p.title, 100)),
    description: sentences([desc || facts, teacher && `Müəllim: ${teacher}`, "Materiala baxın"]),
  };
}

/** Same shape as taskPreviewText; falls back to "Fənn: X" when the exam has no description. */
export function examPreviewText(p: ExamPreview): Text {
  const teacher = oneLine(p.teacherName, 80);
  const desc = oneLine(p.description, 200);
  const subject = p.subject && `Fənn: ${oneLine(p.subject, 60)}`;
  return {
    title: examPageTitle(oneLine(p.title, 100)),
    description: sentences([desc || subject, teacher && `Müəllim: ${teacher}`, "İmtahana baxın"]),
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

export function taskPreviewHead(result: Resolved<TaskPreview>, origin = publicAppUrl()): PreviewHead {
  const text = result.status === "FOUND" ? taskPreviewText(result.preview) : result.status === "NOT_FOUND" ? TASK_NOT_FOUND : TASK_UNAVAILABLE;
  return previewHead(text, result.code ? `/task/${encodeURIComponent(result.code)}` : null, origin);
}

export function materialPreviewHead(result: Resolved<MaterialPreview>, origin = publicAppUrl()): PreviewHead {
  const text = result.status === "FOUND" ? materialPreviewText(result.preview) : result.status === "NOT_FOUND" ? MATERIAL_NOT_FOUND : MATERIAL_UNAVAILABLE;
  return previewHead(text, result.code ? `/material/${encodeURIComponent(result.code)}` : null, origin);
}

export function examPreviewHead(result: Resolved<ExamPreview>, origin = publicAppUrl()): PreviewHead {
  const text = result.status === "FOUND" ? examPreviewText(result.preview) : result.status === "NOT_FOUND" ? EXAM_NOT_FOUND : EXAM_UNAVAILABLE;
  return previewHead(text, result.code ? `/exam/${encodeURIComponent(result.code)}` : null, origin);
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
  taskPreview?: TaskPreviewLookup;
  materialPreview?: MaterialPreviewLookup;
  examPreview?: ExamPreviewLookup;
  groupPreview?: GroupPreviewLookup;
}

/** Resolvers per link type, each with its own timeout and cache. */
export function previewResolvers(sources: PreviewSources, opts?: Parameters<typeof previewResolver>[1]) {
  const syllabus: Resolver<SyllabusPreview> = sources.syllabusPreview ? previewResolver(sources.syllabusPreview, opts) : unconfigured;
  const task: Resolver<TaskPreview> = sources.taskPreview ? previewResolver(sources.taskPreview, opts) : unconfigured;
  const material: Resolver<MaterialPreview> = sources.materialPreview ? previewResolver(sources.materialPreview, opts) : unconfigured;
  const exam: Resolver<ExamPreview> = sources.examPreview ? previewResolver(sources.examPreview, opts) : unconfigured;
  const group = Object.fromEntries(
    GROUP_LINK_KINDS.map((kind) => {
      const source = sources.groupPreview;
      return [kind, source ? previewResolver<GroupLinkPreview>((key) => source(kind, key), opts) : unconfigured];
    }),
  ) as Record<GroupLinkKind, Resolver<GroupLinkPreview>>;
  return { syllabus, task, material, exam, group };
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

/** A task preview from untrusted JSON, or null when it is not one. */
export function parseTaskPreview(raw: unknown): TaskPreview | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return { title: str(r.title, 255), description: str(r.description, 2000), teacherName: str(r.teacherName, 255) };
}

/** A material preview from untrusted JSON, or null when it is not one. */
export function parseMaterialPreview(raw: unknown): MaterialPreview | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return { title: str(r.title, 255), description: str(r.description, 2000), subject: str(r.subject, 255), topic: str(r.topic, 255), teacherName: str(r.teacherName, 255) };
}

/** An exam preview from untrusted JSON, or null when it is not one. */
export function parseExamPreview(raw: unknown): ExamPreview | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  return { title: str(r.title, 255), description: str(r.description, 2000), subject: str(r.subject, 255), teacherName: str(r.teacherName, 255) };
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

/** The frontend service's task lookup: `GET /api/public/task-preview/<code>` on the API. */
export function httpTaskPreviewLookup(apiUrl: string, timeoutMs = PREVIEW_TIMEOUT_MS): TaskPreviewLookup {
  const base = apiUrl.replace(/\/+$/, "");
  return async (code) => {
    const preview = await fetchPreview(`${base}/api/public/task-preview/${encodeURIComponent(code)}`, timeoutMs);
    return preview ? parseTaskPreview(preview) : null;
  };
}

/** The frontend service's material lookup: `GET /api/public/material-preview/<code>` on the API. */
export function httpMaterialPreviewLookup(apiUrl: string, timeoutMs = PREVIEW_TIMEOUT_MS): MaterialPreviewLookup {
  const base = apiUrl.replace(/\/+$/, "");
  return async (code) => {
    const preview = await fetchPreview(`${base}/api/public/material-preview/${encodeURIComponent(code)}`, timeoutMs);
    return preview ? parseMaterialPreview(preview) : null;
  };
}

/** The frontend service's exam lookup: `GET /api/public/exam-preview/<code>` on the API. */
export function httpExamPreviewLookup(apiUrl: string, timeoutMs = PREVIEW_TIMEOUT_MS): ExamPreviewLookup {
  const base = apiUrl.replace(/\/+$/, "");
  return async (code) => {
    const preview = await fetchPreview(`${base}/api/public/exam-preview/${encodeURIComponent(code)}`, timeoutMs);
    return preview ? parseExamPreview(preview) : null;
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
  const task = taskPathCode(urlPath);
  if (task) return injectPreviewHead(shell, taskPreviewHead(await resolvers.task(task.code)));
  const material = materialPathCode(urlPath);
  if (material) return injectPreviewHead(shell, materialPreviewHead(await resolvers.material(material.code)));
  const exam = examPathCode(urlPath);
  if (exam) return injectPreviewHead(shell, examPreviewHead(await resolvers.exam(exam.code)));
  const group = groupPathKey(urlPath);
  if (group) return injectPreviewHead(shell, groupPreviewHead(group.kind, await resolvers.group[group.kind](group.key)));
  return null;
}
