import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { materials, type MaterialRow } from "../../drizzle/schema";
import {
  kindFromMime,
  type MaterialDetails,
  type MaterialStatus,
  type MaterialValues,
  type MaterialVisibility,
} from "../../shared/materialTemplates";
import { requireDb } from "../db";
import { managedWorkspaces, type TeacherScope } from "../modules/access";
import { AppError } from "../modules/errors";
import { materialReachesStudent, visibleMaterialsOfStudent } from "./access";
import { deleteMeta, metaOfMaterial, saveMeta, visibleToStudents, withMeta, type ContentMetaView, type Publishing } from "./meta";
import { notifyMaterialSaved } from "./notify";

/**
 * Materials a teacher shares with groups and/or individual students: a file or a link, plus the
 * template details and publishing state kept in content_meta (server/materials/meta.ts).
 */

const newShareCode = () => nanoid(10).replace(/[-_]/g, "x").toUpperCase();

export interface MaterialInput {
  title: string;
  description: string;
  subject: string;
  topic: string;
  /** Empty for a link material. */
  fileName: string;
  fileId: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  groupIds: string[];
  studentIds: number[];
}

/** Everything about a save beyond the `materials` columns; omitted parts keep their current value. */
export interface MaterialSaveOptions {
  details?: MaterialDetails;
  /** "" or null removes the link. */
  url?: string | null;
  status?: MaterialStatus;
  publishAt?: Date | null;
  visibility?: MaterialVisibility;
  /** Tell students (now, or at the scheduled time). */
  notify?: boolean;
}

/** Pure: the publishing state after a save. A publish time that has already passed means "now". */
export function resolvePublishing(current: Publishing | null, opts: MaterialSaveOptions, now: Date = new Date()): Publishing {
  let publishAt = opts.publishAt !== undefined ? opts.publishAt : (current?.publishAt ?? null);
  if (opts.publishAt !== undefined && publishAt && publishAt.getTime() <= now.getTime()) publishAt = null;
  return {
    status: opts.status ?? current?.status ?? "PUBLISHED",
    publishAt,
    visibility: opts.visibility ?? current?.visibility ?? "LINK",
    notify: opts.notify ?? current?.notify ?? true,
    url: opts.url !== undefined ? opts.url?.trim() || null : (current?.url ?? null),
  };
}

/** Pure: a material is exactly one of a file or a link; a LINK material needs the link. */
export function assertMaterialSource(state: { url: string | null; fileName: string }, kind: MaterialDetails["kind"]) {
  const hasUrl = Boolean(state.url);
  const hasFile = Boolean(state.fileName.trim());
  if (hasUrl === hasFile) throw new AppError("MATERIAL_SOURCE_REQUIRED");
  if (kind === "LINK" && !hasUrl) throw new AppError("MATERIAL_SOURCE_REQUIRED");
}

/** Details for a save from a client that sends none (older forms, scripts): GENERAL, kind from the source. */
export function defaultDetails(input: Pick<MaterialInput, "topic" | "mimeType">, url: string | null): MaterialDetails {
  const values: MaterialValues = {};
  if (input.topic.trim()) values.topics = [input.topic.trim()];
  return { template: "GENERAL", kind: url ? "LINK" : kindFromMime(input.mimeType), values };
}

/** The `materials.subject` / `topic` columns follow the template fields, for lists and older readers. */
function legacyColumns(details: MaterialDetails, fallback: { subject: string; topic: string }) {
  const subject = typeof details.values.subject === "string" && details.values.subject.trim() ? details.values.subject.trim() : fallback.subject;
  const topics = Array.isArray(details.values.topics) ? details.values.topics : null;
  return { subject: subject.slice(0, 120), topic: (topics ? (topics[0] ?? "") : fallback.topic).slice(0, 120) };
}

const linkOnly = { fileName: "", fileId: null, mimeType: null, sizeBytes: null } as const;

/** Throws NOT_FOUND if the material doesn't exist or belongs to another workspace. */
export async function materialOf(scope: TeacherScope, id: string): Promise<MaterialRow> {
  const [row] = await requireDb()
    .select()
    .from(materials)
    .where(and(eq(materials.id, id), eq(materials.providerWorkspaceId, scope.workspaceId)))
    .limit(1);
  if (!row) throw new AppError("NOT_FOUND");
  return row;
}

export async function listMaterialsForWorkspace(workspaceId: string) {
  return withMeta(await requireDb().select().from(materials).where(eq(materials.providerWorkspaceId, workspaceId)).orderBy(materials.uploadedAt));
}

export async function createMaterial(scope: TeacherScope, input: MaterialInput, opts: MaterialSaveOptions = {}) {
  const publishing = resolvePublishing(null, opts);
  const details = opts.details ?? defaultDetails(input, publishing.url);
  assertMaterialSource({ url: publishing.url, fileName: input.fileName }, details.kind);
  const id = nanoid();
  const row = { ...input, ...legacyColumns(details, input), ...(publishing.url ? linkOnly : {}) };
  await requireDb().transaction(async (tx) => {
    await tx.insert(materials).values({ id, providerWorkspaceId: scope.workspaceId, createdBy: scope.userId, shareCode: newShareCode(), ...row });
    await saveMeta(tx, { type: "MATERIAL", id, workspaceId: scope.workspaceId }, details, publishing, row.subject);
  });
  const material = await materialOf(scope, id);
  notifyMaterialSaved({ material, before: null, wasVisible: false, isVisible: visibleToStudents(publishing), notify: publishing.notify, teacherId: scope.userId });
  return (await withMeta([material]))[0];
}

const publishingOf = (meta: ContentMetaView): Publishing => ({ status: meta.status, publishAt: meta.publishAt, visibility: meta.visibility, notify: meta.notify, url: meta.url });

export async function updateMaterial(scope: TeacherScope, id: string, patch: Partial<MaterialInput>, opts: MaterialSaveOptions = {}) {
  const current = await materialOf(scope, id);
  const currentMeta = await metaOfMaterial(current);
  const publishing = resolvePublishing(publishingOf(currentMeta), opts);
  let details: MaterialDetails = opts.details ?? { template: currentMeta.template, kind: currentMeta.kind, values: currentMeta.values };
  if (!opts.details && patch.topic !== undefined && patch.topic.trim() !== current.topic) {
    details = { ...details, values: { ...details.values, topics: patch.topic.trim() ? [patch.topic.trim()] : [] } };
  }
  if (!opts.details && opts.url !== undefined) details = { ...details, kind: publishing.url ? "LINK" : details.kind === "LINK" ? kindFromMime(patch.mimeType ?? current.mimeType) : details.kind };
  const merged = { ...current, ...patch };
  const source = publishing.url ? linkOnly : {};
  assertMaterialSource({ url: publishing.url, fileName: publishing.url ? "" : merged.fileName }, details.kind);
  const set = { ...patch, ...legacyColumns(details, { subject: merged.subject, topic: merged.topic }), ...source };
  await requireDb().transaction(async (tx) => {
    await tx.update(materials).set(set).where(eq(materials.id, id));
    await saveMeta(tx, { type: "MATERIAL", id, workspaceId: scope.workspaceId }, details, publishing, set.subject);
  });
  const material = await materialOf(scope, id);
  notifyMaterialSaved({
    material,
    before: current,
    wasVisible: visibleToStudents(currentMeta),
    isVisible: visibleToStudents(publishing),
    notify: opts.notify ?? publishing.notify,
    teacherId: scope.userId,
  });
  return (await withMeta([material]))[0];
}

export async function deleteMaterial(scope: TeacherScope, id: string) {
  await materialOf(scope, id);
  await requireDb().transaction(async (tx) => {
    await tx.delete(materials).where(eq(materials.id, id));
    await deleteMeta(tx, "MATERIAL", id);
  });
  return { ok: true };
}

/** What a student or a visitor may read of the details: never the teacher's grading criteria. */
export function studentFacingMeta(meta: ContentMetaView) {
  const { gradingCriteria: _hidden, ...values } = meta.values;
  return { template: meta.template, kind: meta.kind, url: meta.url, dueAt: meta.dueAt, visibility: meta.visibility, values };
}

/** The student's materials: reaching them (groups or individually) and visible now. */
export async function studentMaterials(studentId: number, groupIds: string[]) {
  const rows = await visibleMaterialsOfStudent(studentId, groupIds);
  return rows.map(({ meta, ...m }) => ({ ...m, meta: studentFacingMeta(meta) }));
}

export async function materialByShareCode(shareCode: string) {
  const [row] = await requireDb().select().from(materials).where(eq(materials.shareCode, shareCode)).limit(1);
  return row ?? null;
}

export type PublicMaterialAccess = "OWNER" | "ALLOWED" | "SIGN_IN_REQUIRED" | "DENIED";

/**
 * The public share page. Drafts and scheduled materials do not exist there yet (null). A
 * recipients-only material shows its content only to its recipients and the teacher.
 */
export async function publicMaterial(shareCode: string, viewer: { userId: number; groupIds: string[] } | null) {
  const m = await materialByShareCode(shareCode);
  if (!m) return null;
  const meta = await metaOfMaterial(m);
  const owner = viewer ? (await managedWorkspaces(viewer.userId)).some((w) => w.id === m.providerWorkspaceId) : false;
  if (!visibleToStudents(meta) && !owner) return null;
  const access: PublicMaterialAccess = owner
    ? "OWNER"
    : meta.visibility === "LINK"
      ? "ALLOWED"
      : !viewer
        ? "SIGN_IN_REQUIRED"
        : materialReachesStudent(m, viewer.userId, viewer.groupIds)
          ? "ALLOWED"
          : "DENIED";
  const material =
    access === "OWNER" || access === "ALLOWED"
      ? { id: m.id, title: m.title, description: m.description, subject: m.subject, topic: m.topic, fileName: m.fileName, fileId: m.fileId, mimeType: m.mimeType, sizeBytes: m.sizeBytes, ...studentFacingMeta(meta) }
      : null;
  return { access, visibility: meta.visibility, material };
}

/** Self-enrolling via the share link. Not for drafts/scheduled materials, nor recipients-only ones (unless already a recipient). */
export async function claimMaterial(userId: number, shareCode: string, groupIds: string[] = []) {
  const db = requireDb();
  const row = await materialByShareCode(shareCode);
  if (!row) throw new AppError("NOT_FOUND");
  const meta = await metaOfMaterial(row);
  if (!visibleToStudents(meta)) throw new AppError("MATERIAL_NOT_AVAILABLE");
  const reached = materialReachesStudent(row, userId, groupIds);
  if (meta.visibility === "RECIPIENTS" && !reached) throw new AppError("MATERIAL_RESTRICTED");
  if (meta.visibility === "LINK" && !row.studentIds.includes(userId)) {
    await db.update(materials).set({ studentIds: [...row.studentIds, userId] }).where(eq(materials.id, row.id));
  }
  return { id: row.id };
}

/** A visible material that reaches this student (for recording link opens). */
export async function reachableMaterial(studentId: number, groupIds: string[], id: string) {
  const [row] = await requireDb().select().from(materials).where(eq(materials.id, id)).limit(1);
  if (!row || !materialReachesStudent(row, studentId, groupIds)) throw new AppError("NOT_FOUND");
  const meta = await metaOfMaterial(row);
  if (!visibleToStudents(meta)) throw new AppError("NOT_FOUND");
  return { ...row, meta };
}
