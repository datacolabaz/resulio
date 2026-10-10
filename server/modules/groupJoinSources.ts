import { and, count, eq, inArray, isNull, like } from "drizzle-orm";
import {
  groupCodeLimits,
  groupEmailInvites,
  groupInviteLinks,
  groupMembers,
  groupMemberSources,
  groups,
  notificationDeliveries,
  shareEvents,
  syllabi,
  syllabusJoinRequests,
  users,
} from "../../drizzle/schema";
import type { GroupJoinSource, JoinSourceView } from "../../shared/groupJoinSource";
import { requireDb, type DbOrTx } from "../db";
import { isMissingTable } from "../notifications/preferences";

const TAG = "[Groups] join sources";
const CHUNK = 500;
const chunks = <T>(list: readonly T[]) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));

/** Missing table = migration 0043 not applied yet: joins keep working, nothing is recorded or enforced. */
async function tolerant<T>(fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    return fallback;
  }
}

export interface JoinSourceInput {
  groupId: string;
  userId: number;
  joinedVia: GroupJoinSource;
  sourceId?: string | null;
  actorUserId: number | null;
  at?: Date;
}

/**
 * Records how the student's membership in the group became ACTIVE. Every join path calls this
 * right after activating the row, inside the same transaction where there is one. A membership
 * that is re-activated (an approved PENDING row) gets its source replaced.
 */
export async function recordJoinSource(db: DbOrTx, input: JoinSourceInput): Promise<void> {
  const [m] = await db
    .select({ id: groupMembers.id })
    .from(groupMembers)
    .where(and(eq(groupMembers.groupId, input.groupId), eq(groupMembers.userId, input.userId)))
    .limit(1);
  if (!m) return;
  const row = {
    joinedVia: input.joinedVia,
    sourceId: input.sourceId ?? null,
    actorUserId: input.actorUserId,
    joinedAt: input.at ?? new Date(),
    backfilled: false,
  };
  await tolerant(undefined, async () => {
    await db
      .insert(groupMemberSources)
      .values({ membershipId: m.id, groupId: input.groupId, userId: input.userId, ...row })
      .onDuplicateKeyUpdate({ set: row });
  });
}

/** Joins through the group's current code so far (removed members still count) and its optional cap. */
export async function codeUsage(db: DbOrTx, groupId: string, inviteCode: string): Promise<{ uses: number; maxUses: number | null }> {
  return tolerant({ uses: 0, maxUses: null }, async () => {
    const [limit] = await db.select({ maxUses: groupCodeLimits.maxUses }).from(groupCodeLimits).where(eq(groupCodeLimits.groupId, groupId)).limit(1);
    const [used] = await db
      .select({ n: count() })
      .from(groupMemberSources)
      .where(and(eq(groupMemberSources.groupId, groupId), eq(groupMemberSources.joinedVia, "GROUP_CODE_LINK"), eq(groupMemberSources.sourceId, inviteCode)));
    return { uses: Number(used?.n ?? 0), maxUses: limit?.maxUses ?? null };
  });
}

/** Null clears the cap. Returns false before migration 0043. */
export async function setCodeMaxUses(groupId: string, maxUses: number | null): Promise<boolean> {
  return tolerant(false, async () => {
    await requireDb().insert(groupCodeLimits).values({ groupId, maxUses }).onDuplicateKeyUpdate({ set: { maxUses } });
    return true;
  });
}

/** Sources by membership id, with the teacher-facing detail (link label, invited e-mail, syllabus title). */
export async function joinSourcesOf(membershipIds: readonly number[], db: DbOrTx = requireDb()): Promise<Map<number, JoinSourceView>> {
  const out = new Map<number, JoinSourceView>();
  if (!membershipIds.length) return out;
  return tolerant(out, async () => {
    for (const ids of chunks([...new Set(membershipIds)])) {
      const rows = await db
        .select({
          membershipId: groupMemberSources.membershipId,
          joinedVia: groupMemberSources.joinedVia,
          joinedAt: groupMemberSources.joinedAt,
          linkLabel: groupInviteLinks.label,
          inviteEmail: groupEmailInvites.email,
          syllabusTitle: syllabi.title,
        })
        .from(groupMemberSources)
        .leftJoin(groupInviteLinks, and(eq(groupMemberSources.joinedVia, "SINGLE_USE_LINK"), eq(groupInviteLinks.id, groupMemberSources.sourceId)))
        .leftJoin(groupEmailInvites, and(eq(groupMemberSources.joinedVia, "EMAIL_INVITE"), eq(groupEmailInvites.id, groupMemberSources.sourceId)))
        .leftJoin(syllabusJoinRequests, and(eq(groupMemberSources.joinedVia, "SYLLABUS_REQUEST"), eq(syllabusJoinRequests.id, groupMemberSources.sourceId)))
        .leftJoin(syllabi, eq(syllabi.id, syllabusJoinRequests.syllabusId))
        .where(inArray(groupMemberSources.membershipId, ids));
      for (const r of rows) {
        out.set(r.membershipId, { joinedVia: r.joinedVia, joinedAt: r.joinedAt, detail: r.linkLabel || r.inviteEmail || r.syllabusTitle || null });
      }
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// Backfill for memberships older than migration 0043
// ---------------------------------------------------------------------------

/** Evidence counts only if it happened this close to the membership row's creation (a re-added student is a new row). */
export const EVIDENCE_WINDOW_MS = 10 * 60_000;

export interface BackfillMembership {
  membershipId: number;
  groupId: string;
  userId: number;
  joinedAt: Date;
}

export interface JoinEvidence {
  /** Single-use links of the group this user redeemed. */
  links: { id: string; at: Date }[];
  /** Accepted e-mail invites of the group addressed to this user's e-mail. */
  emailInvites: { id: string; at: Date }[];
  /** Accepted GROUP syllabus join requests for this group. */
  requests: { id: string; at: Date; decidedBy: number | null }[];
  /** The teacher's "joined via the invite link" notice for exactly this membership (time it was queued). */
  codeNoticeAt: Date | null;
  /** Share tracking JOINED events of this user on the group's current code. */
  codeJoins: { code: string; at: Date }[];
}

export interface BackfillRow {
  membershipId: number;
  groupId: string;
  userId: number;
  joinedVia: GroupJoinSource;
  sourceId: string | null;
  actorUserId: number | null;
  joinedAt: Date;
  backfilled: true;
}

const near = (m: BackfillMembership, at: Date) => Math.abs(at.getTime() - m.joinedAt.getTime()) <= EVIDENCE_WINDOW_MS;

/** Pure: the most specific evidence wins; nothing on record = UNKNOWN at the row's creation time. */
export function deriveJoinSource(m: BackfillMembership, ev: JoinEvidence): BackfillRow {
  const base = { membershipId: m.membershipId, groupId: m.groupId, userId: m.userId, backfilled: true as const };
  const link = ev.links.find((l) => near(m, l.at));
  if (link) return { ...base, joinedVia: "SINGLE_USE_LINK", sourceId: link.id, actorUserId: m.userId, joinedAt: link.at };
  const invite = ev.emailInvites.find((i) => near(m, i.at));
  if (invite) return { ...base, joinedVia: "EMAIL_INVITE", sourceId: invite.id, actorUserId: m.userId, joinedAt: invite.at };
  const request = ev.requests.find((r) => near(m, r.at));
  if (request) return { ...base, joinedVia: "SYLLABUS_REQUEST", sourceId: request.id, actorUserId: request.decidedBy, joinedAt: request.at };
  if (ev.codeNoticeAt) return { ...base, joinedVia: "GROUP_CODE_LINK", sourceId: null, actorUserId: m.userId, joinedAt: ev.codeNoticeAt };
  const code = ev.codeJoins.find((c) => near(m, c.at));
  if (code) return { ...base, joinedVia: "GROUP_CODE_LINK", sourceId: code.code, actorUserId: m.userId, joinedAt: code.at };
  return { ...base, joinedVia: "UNKNOWN", sourceId: null, actorUserId: null, joinedAt: m.joinedAt };
}

/** `group-join:<membershipId>:<channel>` → membership id (see groupJoin.linkJoinKey). */
export function membershipIdOfNoticeKey(key: string): number | null {
  const m = /^group-join:(\d+):/.exec(key);
  return m ? Number(m[1]) : null;
}

const pushTo = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

/**
 * Every start: gives each ACTIVE membership without a source row one, derived from what is on
 * record. INSERT IGNORE, so a source written meanwhile by a join (or another instance) wins.
 */
export async function runJoinSourceBackfill(db: DbOrTx = requireDb()): Promise<BackfillRow[]> {
  try {
    const missing = await db
      .select({ membershipId: groupMembers.id, groupId: groupMembers.groupId, userId: groupMembers.userId, joinedAt: groupMembers.joinedAt, email: users.email, inviteCode: groups.inviteCode })
      .from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId))
      .leftJoin(users, eq(users.id, groupMembers.userId))
      .leftJoin(groupMemberSources, eq(groupMemberSources.membershipId, groupMembers.id))
      .where(and(eq(groupMembers.status, "ACTIVE"), isNull(groupMemberSources.membershipId)));
    if (!missing.length) return [];

    const notices = new Map<number, Date>();
    for (const n of await db
      .select({ key: notificationDeliveries.dedupeKey, at: notificationDeliveries.createdAt })
      .from(notificationDeliveries)
      .where(and(eq(notificationDeliveries.event, "GROUP_MEMBER_JOINED"), like(notificationDeliveries.dedupeKey, "group-join:%")))) {
      const id = membershipIdOfNoticeKey(n.key);
      if (id !== null && (!notices.has(id) || n.at < notices.get(id)!)) notices.set(id, n.at);
    }

    const plan: BackfillRow[] = [];
    for (const part of chunks(missing)) {
      const groupIds = [...new Set(part.map((m) => m.groupId))];
      const userIds = [...new Set(part.map((m) => m.userId))];
      const key = (groupId: string, userId: number) => `${groupId}:${userId}`;

      const links = new Map<string, JoinEvidence["links"]>();
      for (const l of await db
        .select({ id: groupInviteLinks.id, groupId: groupInviteLinks.groupId, userId: groupInviteLinks.usedByUserId, at: groupInviteLinks.usedAt })
        .from(groupInviteLinks)
        .where(and(inArray(groupInviteLinks.groupId, groupIds), inArray(groupInviteLinks.usedByUserId, userIds)))) {
        if (l.userId !== null && l.at) pushTo(links, key(l.groupId, l.userId), { id: l.id, at: l.at });
      }

      const invites = new Map<string, JoinEvidence["emailInvites"]>();
      for (const i of await db
        .select({ id: groupEmailInvites.id, groupId: groupEmailInvites.groupId, email: groupEmailInvites.email, at: groupEmailInvites.acceptedAt })
        .from(groupEmailInvites)
        .where(and(inArray(groupEmailInvites.groupId, groupIds), eq(groupEmailInvites.status, "ACCEPTED")))) {
        if (i.at) pushTo(invites, `${i.groupId}:${i.email.toLowerCase()}`, { id: i.id, at: i.at });
      }

      const requests = new Map<string, JoinEvidence["requests"]>();
      for (const r of await db
        .select({ id: syllabusJoinRequests.id, groupId: syllabusJoinRequests.groupId, userId: syllabusJoinRequests.studentId, at: syllabusJoinRequests.decidedAt, decidedBy: syllabusJoinRequests.decidedBy })
        .from(syllabusJoinRequests)
        .where(and(inArray(syllabusJoinRequests.groupId, groupIds), eq(syllabusJoinRequests.status, "ACCEPTED"), eq(syllabusJoinRequests.type, "GROUP")))) {
        if (r.groupId && r.at) pushTo(requests, key(r.groupId, r.userId), { id: r.id, at: r.at, decidedBy: r.decidedBy });
      }

      const codeJoins = new Map<string, JoinEvidence["codeJoins"]>();
      const codes = [...new Set(part.map((m) => m.inviteCode))];
      const groupOfCode = new Map(part.map((m) => [m.inviteCode, m.groupId]));
      for (const e of await db
        .select({ code: shareEvents.targetId, userId: shareEvents.actorUserId, at: shareEvents.createdAt })
        .from(shareEvents)
        .where(and(eq(shareEvents.targetType, "GROUP"), eq(shareEvents.eventType, "JOINED"), inArray(shareEvents.targetId, codes), inArray(shareEvents.actorUserId, userIds)))) {
        const groupId = groupOfCode.get(e.code);
        if (groupId && e.userId !== null) pushTo(codeJoins, key(groupId, e.userId), { code: e.code, at: e.at });
      }

      for (const m of part) {
        const k = key(m.groupId, m.userId);
        plan.push(
          deriveJoinSource(m, {
            links: links.get(k) ?? [],
            emailInvites: m.email ? (invites.get(`${m.groupId}:${m.email.toLowerCase()}`) ?? []) : [],
            requests: requests.get(k) ?? [],
            codeNoticeAt: notices.get(m.membershipId) ?? null,
            codeJoins: codeJoins.get(k) ?? [],
          }),
        );
      }
    }
    for (const part of chunks(plan)) await db.insert(groupMemberSources).ignore().values(part);
    const byVia = new Map<string, number>();
    for (const r of plan) byVia.set(r.joinedVia, (byVia.get(r.joinedVia) ?? 0) + 1);
    console.log(`${TAG}: recorded ${plan.length} membership source(s): ${[...byVia].map(([k, n]) => `${k}=${n}`).join(", ")}`);
    return plan;
  } catch (error) {
    if (!isMissingTable(error)) throw error;
    console.warn(`${TAG}: backfill waits for migration 0043`);
    return [];
  }
}
