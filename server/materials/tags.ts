import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import { nanoid } from "nanoid";
import { contentTagLinks, contentTags, questionTopics } from "../../drizzle/schema";
import { cleanTags, tagKey, type ContentEntityType, type TagType } from "../../shared/materialTemplates";
import { normalizeForMatch } from "../../shared/questionImport";
import { requireDb, type DbOrTx } from "../db";
import { isMissingTable } from "../notifications/preferences";

export type EntityTags = Record<TagType, string[]>;

/** Tag names per entity, in the order the teacher gave them. Empty before migration 0042. */
export async function loadTags(entityType: ContentEntityType, ids: readonly string[], db: DbOrTx = requireDb()): Promise<Map<string, EntityTags>> {
  const out = new Map<string, EntityTags>();
  if (!ids.length) return out;
  try {
    const rows = await db
      .select({ entityId: contentTagLinks.entityId, type: contentTags.type, name: contentTags.name })
      .from(contentTagLinks)
      .innerJoin(contentTags, eq(contentTags.id, contentTagLinks.tagId))
      .where(and(eq(contentTagLinks.entityType, entityType), inArray(contentTagLinks.entityId, [...new Set(ids)])))
      .orderBy(asc(contentTagLinks.position));
    for (const r of rows) {
      const tags = out.get(r.entityId) ?? { TOPIC: [], TECHNOLOGY: [] };
      tags[r.type].push(r.name);
      out.set(r.entityId, tags);
    }
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  return out;
}

/** The workspace's tag ids for these names, creating the missing ones (linked to a question bank topic of the same name). */
async function ensureTags(db: DbOrTx, workspaceId: string, type: TagType, names: string[]): Promise<Map<string, string>> {
  const byKey = new Map(names.map((n) => [tagKey(n), n] as const));
  const keys = [...byKey.keys()];
  const find = () =>
    db
      .select({ id: contentTags.id, nameKey: contentTags.nameKey })
      .from(contentTags)
      .where(and(eq(contentTags.workspaceId, workspaceId), eq(contentTags.type, type), inArray(contentTags.nameKey, keys)));
  const existing = await find();
  const missing = keys.filter((k) => !existing.some((e) => e.nameKey === k));
  if (missing.length) {
    const topics =
      type === "TOPIC"
        ? await db
            .select({ id: questionTopics.id, nameKey: questionTopics.nameKey })
            .from(questionTopics)
            .where(and(eq(questionTopics.providerWorkspaceId, workspaceId), inArray(questionTopics.nameKey, missing.map((k) => normalizeForMatch(byKey.get(k)!).slice(0, 120)))))
        : [];
    await db
      .insert(contentTags)
      .ignore()
      .values(
        missing.map((k) => {
          const name = byKey.get(k)!;
          const topicKey = normalizeForMatch(name).slice(0, 120);
          return { id: nanoid(), workspaceId, type, name, nameKey: k, questionTopicId: topics.find((t) => t.nameKey === topicKey)?.id ?? null };
        }),
      );
  }
  const rows = missing.length ? await find() : existing;
  return new Map(rows.map((r) => [r.nameKey, r.id] as const));
}

/** Replaces an entity's tags (an empty list removes them all). */
export async function replaceTags(db: DbOrTx, entity: { type: ContentEntityType; id: string; workspaceId: string }, tags: EntityTags) {
  await db.delete(contentTagLinks).where(and(eq(contentTagLinks.entityType, entity.type), eq(contentTagLinks.entityId, entity.id)));
  const links: (typeof contentTagLinks.$inferInsert)[] = [];
  for (const type of ["TOPIC", "TECHNOLOGY"] as const) {
    const names = cleanTags(tags[type]);
    if (!names.length) continue;
    const ids = await ensureTags(db, entity.workspaceId, type, names);
    names.forEach((n) => {
      const tagId = ids.get(tagKey(n));
      if (tagId) links.push({ entityType: entity.type, entityId: entity.id, tagId, position: links.length });
    });
  }
  if (links.length) await db.insert(contentTagLinks).ignore().values(links);
}

export interface TagSuggestion {
  name: string;
  /** Where it came from: a tag used before in this workspace, or a question bank subject/section. */
  source: "TAG" | "QUESTION_BANK";
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Suggestions for a tag field: tags already used in the workspace (most used first), then for
 * topics the question bank's subjects and sections. Matches anywhere in the normalized name.
 */
export async function suggestTags(workspaceId: string, type: TagType, query: string, limit = 10): Promise<TagSuggestion[]> {
  const db = requireDb();
  const key = tagKey(query);
  const pattern = `%${escapeLike(key)}%`;
  const out: TagSuggestion[] = [];
  const seen = new Set<string>();
  const push = (name: string, source: TagSuggestion["source"]) => {
    const k = tagKey(name);
    if (!k || seen.has(k) || out.length >= limit) return;
    seen.add(k);
    out.push({ name, source });
  };
  try {
    const used = await db
      .select({ name: contentTags.name, uses: sql<number>`count(${contentTagLinks.tagId})` })
      .from(contentTags)
      .leftJoin(contentTagLinks, eq(contentTagLinks.tagId, contentTags.id))
      .where(and(eq(contentTags.workspaceId, workspaceId), eq(contentTags.type, type), key ? like(contentTags.nameKey, pattern) : undefined))
      .groupBy(contentTags.id, contentTags.name)
      .orderBy(sql`count(${contentTagLinks.tagId}) desc`, asc(contentTags.name))
      .limit(limit);
    for (const r of used) push(r.name, "TAG");
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  if (type === "TOPIC" && out.length < limit) {
    try {
      const topics = await db
        .select({ name: questionTopics.name })
        .from(questionTopics)
        .where(and(eq(questionTopics.providerWorkspaceId, workspaceId), key ? like(questionTopics.nameKey, `%${escapeLike(normalizeForMatch(query))}%`) : undefined))
        .orderBy(asc(questionTopics.position), asc(questionTopics.name))
        .limit(limit * 2);
      for (const t of topics) push(t.name, "QUESTION_BANK");
    } catch (error) {
      if (!isMissingTable(error)) throw error;
    }
  }
  return out;
}
