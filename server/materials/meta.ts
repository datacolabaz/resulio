import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { contentMeta, materials, type ContentMetaRow, type MaterialRow } from "../../drizzle/schema";
import {
  FIELD_STORAGE,
  TEMPLATES,
  compactValues,
  isKind,
  isTemplate,
  kindFromMime,
  parseWebUrl,
  tagKey,
  type ContentEntityType,
  type FieldKey,
  type FieldValue,
  type MaterialDetails,
  type MaterialKind,
  type MaterialStatus,
  type MaterialTemplate,
  type MaterialValues,
  type MaterialVisibility,
} from "../../shared/materialTemplates";
import { requireDb, type DbOrTx } from "../db";
import { isMissingTable } from "../notifications/preferences";
import { loadTags, replaceTags, type EntityTags } from "./tags";

const TAG = "[Materials] meta";
const CHUNK = 500;
const chunks = <T>(list: readonly T[]) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));

/** How a material (or a task made from the material form) is described and published. */
export interface ContentMetaView {
  template: MaterialTemplate;
  kind: MaterialKind;
  status: MaterialStatus;
  publishAt: Date | null;
  visibility: MaterialVisibility;
  notify: boolean;
  notifiedAt: Date | null;
  url: string | null;
  dueAt: Date | null;
  values: MaterialValues;
  /** True for a material saved before templates (no content_meta row yet). */
  legacy: boolean;
}

export interface Publishing {
  status: MaterialStatus;
  publishAt: Date | null;
  visibility: MaterialVisibility;
  notify: boolean;
  url: string | null;
}

/** A material saved before templates: a published GENERAL file (topic as its one tag), open by link. */
export function legacyMeta(m: Pick<MaterialRow, "mimeType" | "subject" | "topic">): ContentMetaView {
  const values: MaterialValues = {};
  if (m.topic.trim()) values.topics = [m.topic.trim()];
  return {
    template: "GENERAL",
    kind: kindFromMime(m.mimeType),
    status: "PUBLISHED",
    publishAt: null,
    visibility: "LINK",
    notify: false,
    notifiedAt: null,
    url: null,
    dueAt: null,
    values,
    legacy: true,
  };
}

const COLUMN_OF: Partial<Record<FieldKey, keyof ContentMetaRow>> = {
  grade: "gradeLevel",
  examType: "examType",
  direction: "direction",
  skill: "skill",
  level: "level",
  difficulty: "difficulty",
  language: "language",
  dueAt: "dueAt",
  estimatedMinutes: "estimatedMinutes",
};

/** Pure: the stored row (plus tags and the material's own subject) back into form values. */
export function metaFromRow(row: ContentMetaRow, tags: EntityTags | undefined, subject: string): ContentMetaView {
  const template = isTemplate(row.template) ? row.template : "GENERAL";
  const values: MaterialValues = {};
  const extra = row.extra ?? {};
  for (const def of TEMPLATES[template].fields) {
    const where = FIELD_STORAGE[def.key];
    let v: unknown;
    if (def.key === "subject") v = subject || (typeof extra.subject === "string" ? extra.subject : "");
    else if (where === "column") v = row[COLUMN_OF[def.key]!];
    else if (where === "tags") v = def.key === "topics" ? tags?.TOPIC : tags?.TECHNOLOGY;
    else v = extra[def.key];
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length)) continue;
    values[def.key] = v as FieldValue;
  }
  return {
    template,
    kind: isKind(row.kind) ? row.kind : "FILE",
    status: row.status,
    publishAt: row.publishAt,
    visibility: row.visibility,
    notify: row.notify,
    notifiedAt: row.notifiedAt,
    url: row.url,
    dueAt: row.dueAt,
    values,
    legacy: false,
  };
}

const str = (v: FieldValue | undefined, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const num = (v: FieldValue | undefined) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);

/** Pure: form values into the row's columns, `extra` and tags. `subject`: the material's own subject when the template has no subject field. */
export function rowFromDetails(details: MaterialDetails, subjectFallback = "") {
  const values = compactValues(details.template, details.values);
  const extra: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(values) as [FieldKey, FieldValue][]) {
    if (FIELD_STORAGE[key] === "extra") extra[key] = v instanceof Date ? v.toISOString() : v;
  }
  const subject = str(values.subject, 120) || subjectFallback.trim().slice(0, 120);
  if (subject) extra.subject = subject;
  return {
    columns: {
      template: details.template,
      kind: details.kind,
      subjectKey: tagKey(subject).slice(0, 120),
      gradeLevel: str(values.grade, 32),
      direction: str(values.direction, 64),
      examType: str(values.examType, 64),
      skill: str(values.skill, 32),
      level: str(values.level, 32),
      difficulty: str(values.difficulty, 16),
      language: str(values.language, 64),
      dueAt: values.dueAt instanceof Date ? values.dueAt : null,
      estimatedMinutes: num(values.estimatedMinutes),
      extra,
    },
    subject,
    tags: { TOPIC: (values.topics as string[] | undefined) ?? [], TECHNOLOGY: (values.technologies as string[] | undefined) ?? [] },
  };
}

/** Visible to students: published, and its publish time (if any) has come. Drafts and scheduled ones are not. */
export function visibleToStudents(meta: Pick<ContentMetaView, "status" | "publishAt">, now: Date = new Date()): boolean {
  return meta.status === "PUBLISHED" && (!meta.publishAt || meta.publishAt.getTime() <= now.getTime());
}

/** Rows by entity id; empty before migration 0042 so reads still work. */
export async function loadMetaRows(entityType: ContentEntityType, ids: readonly string[], db: DbOrTx = requireDb()): Promise<Map<string, ContentMetaRow>> {
  const out = new Map<string, ContentMetaRow>();
  try {
    for (const part of chunks([...new Set(ids)])) {
      const rows = await db.select().from(contentMeta).where(and(eq(contentMeta.entityType, entityType), inArray(contentMeta.entityId, part)));
      for (const r of rows) out.set(r.entityId, r);
    }
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  return out;
}

/** Materials with their `meta` (a legacy view where there is no row yet). */
export async function withMeta<T extends MaterialRow>(rows: readonly T[], db: DbOrTx = requireDb()): Promise<Array<T & { meta: ContentMetaView }>> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [metaRows, tags] = await Promise.all([loadMetaRows("MATERIAL", ids, db), loadTags("MATERIAL", ids, db)]);
  return rows.map((r) => {
    const row = metaRows.get(r.id);
    return { ...r, meta: row ? metaFromRow(row, tags.get(r.id), r.subject) : legacyMeta(r) };
  });
}

export async function metaOfMaterial(material: MaterialRow, db: DbOrTx = requireDb()): Promise<ContentMetaView> {
  return (await withMeta([material], db))[0].meta;
}

/**
 * Writes the details and publishing state of one entity (replacing tags). `notifiedAt` is set by
 * the caller's publish step, never here, except that a draft or a future publish time clears it.
 */
export async function saveMeta(
  db: DbOrTx,
  entity: { type: ContentEntityType; id: string; workspaceId: string },
  details: MaterialDetails,
  publishing: Publishing,
  subjectFallback = "",
) {
  const { columns, tags } = rowFromDetails(details, subjectFallback);
  const url = publishing.url && parseWebUrl(publishing.url) ? publishing.url.trim() : null;
  const set = {
    ...columns,
    status: publishing.status,
    publishAt: publishing.publishAt,
    visibility: publishing.visibility,
    notify: publishing.notify,
    url,
    urlHost: url ? (parseWebUrl(url)?.hostname.slice(0, 255) ?? null) : null,
  };
  const pending = !visibleToStudents(publishing) ? { notifiedAt: null } : {};
  await db
    .insert(contentMeta)
    // Tasks announce themselves (TASK_ASSIGNED); their rows never wait for the material sweeper.
    .values({ entityType: entity.type, entityId: entity.id, workspaceId: entity.workspaceId, ...set, notifiedAt: entity.type === "TASK" ? new Date() : null })
    .onDuplicateKeyUpdate({ set: { ...set, ...pending } });
  await replaceTags(db, entity, tags);
}

/** Marks publishing as handled; false when someone else already did (sweeper vs. save). */
export async function claimPublish(entityType: ContentEntityType, id: string, db: DbOrTx = requireDb()): Promise<boolean> {
  const [result] = await db
    .update(contentMeta)
    .set({ notifiedAt: new Date() })
    .where(and(eq(contentMeta.entityType, entityType), eq(contentMeta.entityId, id), isNull(contentMeta.notifiedAt)));
  return result.affectedRows === 1;
}

export async function deleteMeta(db: DbOrTx, entityType: ContentEntityType, id: string) {
  try {
    await db.delete(contentMeta).where(and(eq(contentMeta.entityType, entityType), eq(contentMeta.entityId, id)));
    await replaceTags(db, { type: entityType, id, workspaceId: "" }, { TOPIC: [], TECHNOLOGY: [] });
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
}

/**
 * Gives every material saved before templates its content_meta row (INSERT IGNORE, so a row the
 * teacher has since saved is never touched): GENERAL, kind from the file type, published, open by
 * link, already "notified" so nobody is told about old materials, and the old topic as a tag.
 */
export async function runMaterialMetaBackfill(db: DbOrTx = requireDb()): Promise<number> {
  let written = 0;
  try {
    const missing = await db
      .select()
      .from(materials)
      .where(sql`not exists (select 1 from ${contentMeta} c where c.entityType = 'MATERIAL' and c.entityId = ${materials.id})`);
    for (const part of chunks(missing)) {
      for (const m of part) {
        const view = legacyMeta(m);
        const subject = m.subject.trim().slice(0, 120);
        const [result] = await db
          .insert(contentMeta)
          .ignore()
          .values({
            entityType: "MATERIAL",
            entityId: m.id,
            workspaceId: m.providerWorkspaceId,
            template: "GENERAL",
            kind: view.kind,
            status: "PUBLISHED",
            visibility: "LINK",
            notify: false,
            notifiedAt: m.uploadedAt,
            subjectKey: tagKey(subject).slice(0, 120),
            extra: subject ? { subject } : {},
          });
        if (result.affectedRows !== 1) continue;
        written++;
        const topics = (view.values.topics as string[] | undefined) ?? [];
        if (topics.length) await replaceTags(db, { type: "MATERIAL", id: m.id, workspaceId: m.providerWorkspaceId }, { TOPIC: topics, TECHNOLOGY: [] });
      }
    }
    if (written) console.info(`${TAG}: backfilled ${written} material(s)`);
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    console.warn(`${TAG}: content_meta missing; apply migration 0042`);
  }
  return written;
}
