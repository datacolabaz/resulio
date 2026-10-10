import { and, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { groupMembers, syllabusAccessGrants, syllabusEnrollments, type User } from "../../drizzle/schema";
import { resetRateLimits } from "../_core/rateLimit";
import * as access from "../syllabus/access";
import * as authoring from "../syllabus/authoring";
import { setWorkspaceEnabled } from "../syllabus/availability";
import * as learning from "../syllabus/learning";
import * as publishing from "../syllabus/publishing";
import { caller, db, makeGroup, makeTeacher, makeUser, outcome } from "./fixtures";

/**
 * The syllabus card counts and the student list behind them: the same deduplicated population,
 * owner-only, and limited.
 */

const DAY = 86_400_000;
let teacher: Awaited<ReturnType<typeof makeTeacher>>;
let other: Awaited<ReturnType<typeof makeTeacher>>;
let syllabusId: string;
let s: Record<"s1" | "s2" | "s3" | "s4" | "s5" | "s6" | "s7" | "waiting" | "foreign", User>;
let g1: { id: string; name: string };
let g2: { id: string; name: string };

const setProgress = (studentId: number, progressPct: number, lastActivityAt: Date) =>
  db()
    .update(syllabusEnrollments)
    .set({ progressPct, lastActivityAt })
    .where(and(eq(syllabusEnrollments.syllabusId, syllabusId), eq(syllabusEnrollments.studentId, studentId)));

beforeAll(async () => {
  teacher = await makeTeacher("Kart müəllimi");
  other = await makeTeacher("Başqa müəllim");
  await setWorkspaceEnabled(teacher.workspaceId, true, teacher.user.id);
  await setWorkspaceEnabled(other.workspaceId, true, other.user.id);
  const names = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "waiting", "foreign"] as const;
  s = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await makeUser(`Tələbə ${n}`)]))) as typeof s;
  g1 = await makeGroup(teacher.scope, [s.s1, s.s2, s.s3]);
  g2 = await makeGroup(teacher.scope, [s.s3, s.s4]);
  await db().insert(groupMembers).values({ groupId: g1.id, userId: s.waiting.id, status: "PENDING" });
  const foreignGroup = await makeGroup(other.scope, [s.foreign]);
  // Individual grants need the student to be the teacher's: s5–s7 join a group that gets no grant.
  await makeGroup(teacher.scope, [s.s5, s.s6, s.s7]);

  const syllabus = await authoring.createSyllabus(teacher.scope, { title: "Data Analytics" });
  syllabusId = syllabus.id;
  const mod = await authoring.createModule(teacher.scope, syllabusId, { title: "Excel" });
  const lesson = await authoring.createLesson(teacher.scope, mod.id, { title: "Dərs 1" });
  await authoring.createItem(teacher.scope, syllabusId, { scope: "LESSON", lessonId: lesson.id }, { kind: "THEORY", title: "Giriş", content: { blocks: [{ type: "markdown", md: "Salam" }] } });
  await publishing.publish(teacher.scope, syllabusId, { label: "v1" });

  const now = Date.now();
  await access.grantAccess(teacher.scope, syllabusId, { groupIds: [g1.id, g2.id], studentIds: [s.s1.id, s.s5.id], startsAt: null, endsAt: null });
  await access.grantAccess(teacher.scope, syllabusId, { groupIds: [], studentIds: [s.s6.id], startsAt: new Date(now + 5 * DAY), endsAt: null });
  const [expired] = (await access.grantAccess(teacher.scope, syllabusId, { groupIds: [], studentIds: [s.s7.id], startsAt: null, endsAt: null })).filter((g) => g.studentId === s.s7.id);
  // A row pointing at another workspace's group must never count (tampering / bad data).
  await db().insert(syllabusAccessGrants).values({ id: nanoid(), syllabusId, groupId: foreignGroup.id, studentId: null, grantedBy: teacher.user.id });

  for (const id of [s.s1.id, s.s4.id, s.s7.id]) await learning.learningPath(id, syllabusId);
  await access.updateGrantDates(teacher.scope, syllabusId, expired.id, { startsAt: new Date(now - 3 * DAY), endsAt: new Date(now - DAY) });
  await setProgress(s.s1.id, 40, new Date(now - 3 * DAY));
  await setProgress(s.s4.id, 10, new Date(now - DAY));
  await setProgress(s.s7.id, 90, new Date(now - 2 * DAY));
});

beforeEach(() => resetRateLimits());

describe("syllabus card students", () => {
  it("counts each student once, across group and individual grants, ignoring pending members and foreign groups", async () => {
    const [card] = (await caller(teacher.user).teacher.syllabus.list()).filter((x) => x.id === syllabusId);
    expect(card.roster).toEqual({
      students: 5, // s1 (group + individual), s2, s3 (two groups), s4, s5
      pending: 1, // s6 starts in 5 days
      ended: 1, // s7 expired
      total: 7,
      groups: 2,
      individual: 3, // s1, s5 and s6 (starts later); s7's grant has expired
      enrolled: 3,
      averageProgressPct: 46.7,
    });
  });

  it("the card and the popover read the same numbers", async () => {
    const t = caller(teacher.user).teacher.syllabus;
    const [card] = (await t.list()).filter((x) => x.id === syllabusId);
    const roster = await t.roster({ id: syllabusId });
    expect(roster.summary).toEqual(card.roster);
    expect(roster.students).toHaveLength(card.roster.total);
    expect(new Set(roster.students.map((r) => r.studentId)).size).toBe(roster.students.length);
    expect(roster.students.filter((r) => r.access === "ACTIVE")).toHaveLength(card.roster.students);
    expect(card.liveGrantCount).toBe(card.roster.groups + card.roster.individual);
  });

  it("says how each student got access and lists current students first", async () => {
    const roster = await caller(teacher.user).teacher.syllabus.roster({ id: syllabusId, sort: "progress" });
    const by = new Map(roster.students.map((r) => [r.studentId, r]));
    expect(by.get(s.s1.id)).toMatchObject({ access: "ACTIVE", groups: [g1.name], individual: true, progressPct: 40 });
    expect([...by.get(s.s3.id)!.groups].sort()).toEqual([g1.name, g2.name].sort());
    expect(by.get(s.s5.id)).toMatchObject({ groups: [], individual: true, progressPct: null, lastActivityAt: null });
    expect(by.get(s.s6.id)).toMatchObject({ access: "PENDING", individual: true });
    expect(by.get(s.s7.id)).toMatchObject({ access: "EXPIRED", progressPct: 90 });
    expect(by.has(s.waiting.id)).toBe(false);
    expect(by.has(s.foreign.id)).toBe(false);

    const ids = roster.students.map((r) => r.studentId);
    expect(ids.slice(0, 2)).toEqual([s.s1.id, s.s4.id]);
    expect(ids.at(-1)).toBe(s.s7.id);

    const recent = await caller(teacher.user).teacher.syllabus.roster({ id: syllabusId, sort: "activity" });
    expect(recent.students.slice(0, 2).map((r) => r.studentId)).toEqual([s.s4.id, s.s1.id]);
  });

  it("is limited, but the summary still covers everyone", async () => {
    const t = caller(teacher.user).teacher.syllabus;
    const two = await t.roster({ id: syllabusId, limit: 2 });
    expect(two.students).toHaveLength(2);
    expect(two.summary.total).toBe(7);
    expect(await outcome(t.roster({ id: syllabusId, limit: 101 }))).toMatch(/^BAD_REQUEST:/);
    expect(await outcome(t.roster({ id: syllabusId, limit: 0 }))).toMatch(/^BAD_REQUEST:/);
  });

  it("is for the owner only", async () => {
    expect(await outcome(caller(other.user).teacher.syllabus.roster({ id: syllabusId }))).toBe("NOT_FOUND:NOT_FOUND");
    expect(await outcome(caller(s.s1).teacher.syllabus.roster({ id: syllabusId }))).toBe("FORBIDDEN:NO_WORKSPACE");
    expect(await outcome(caller(null).teacher.syllabus.roster({ id: syllabusId }))).toMatch(/^UNAUTHORIZED:/);
    const theirs = await caller(other.user).teacher.syllabus.list();
    expect(theirs.some((x) => x.id === syllabusId)).toBe(false);
  });
});
