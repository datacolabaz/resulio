import type { ClassScheduleEntry } from "../../shared/schedule";
import { UPCOMING_GROUP_WINDOW_DAYS, type JoinRequestType } from "../../shared/syllabusJoin";
import { hasModuleDetails, type ModuleDetails } from "../../shared/syllabusModuleDetails";
import { emptyTiming, hasCourseTiming, type SyllabusTiming } from "../../shared/syllabusTiming";
import type { AppErrorCode } from "../modules/errors";
import { grantState, type GrantLike } from "./accessRules";
import { withLegacyFallback } from "./legacyModuleDetails";
import type { ItemStub, VersionStructure } from "./types";

/**
 * Pure rules of the public syllabus page (`/syllabus/<code>`) and the join requests sent from it.
 * Nothing here reads the database, so the whitelist and the request rules are unit-tested directly.
 */

const DAY_MS = 86_400_000;
/** Asia/Baku is UTC+4 all year (no DST). */
const BAKU_OFFSET_MS = 4 * 3_600_000;

/** Only a published, not archived syllabus can be shown through its share link. */
export function isShareable(s: { currentVersionId: string | null; status: string; archivedAt: Date | null }): s is { currentVersionId: string; status: string; archivedAt: null } {
  return !!s.currentVersionId && s.status !== "ARCHIVED" && !s.archivedAt;
}

/** Midnight in Baku of the day `now` falls on, as a UTC instant. */
export function startOfBakuDay(now: Date): Date {
  return new Date(Math.floor((now.getTime() + BAKU_OFFSET_MS) / DAY_MS) * DAY_MS - BAKU_OFFSET_MS);
}

export interface ListingCandidate {
  id: string;
  name: string;
  workspaceId: string;
  startDate: Date | null;
  classSchedule: ClassScheduleEntry[] | null;
  scheduleVisible: boolean;
  format: string;
  language: string;
}

export interface UpcomingGroup {
  id: string;
  name: string;
  startDate: Date;
  /** Only when the teacher made the group's schedule public. */
  classSchedule: ClassScheduleEntry[];
  format: string;
  language: string;
}

/**
 * Groups offered on the share page: the teacher listed the group for this syllabus, the group still
 * holds a live grant for it (active, or opening later; not revoked or expired), it belongs to the
 * syllabus' workspace, and it starts between today (Baku) and today + UPCOMING_GROUP_WINDOW_DAYS.
 * Groups have no archive or capacity fields, so those cannot rule a group out.
 */
export function selectUpcomingGroups(input: {
  workspaceId: string;
  candidates: readonly ListingCandidate[];
  listedGroupIds: readonly string[];
  grants: readonly Pick<GrantLike, "groupId" | "status" | "startsAt" | "endsAt">[];
  now: Date;
  windowDays?: number;
}): UpcomingGroup[] {
  const { now } = input;
  const from = startOfBakuDay(now).getTime();
  const until = from + (input.windowDays ?? UPCOMING_GROUP_WINDOW_DAYS) * DAY_MS;
  const listed = new Set(input.listedGroupIds);
  const granted = new Set(
    input.grants.flatMap((g) => {
      const state = grantState(g, now);
      return g.groupId && (state === "ACTIVE" || state === "PENDING") ? [g.groupId] : [];
    }),
  );
  return input.candidates
    .filter((g) => listed.has(g.id) && granted.has(g.id) && g.workspaceId === input.workspaceId)
    .filter((g): g is ListingCandidate & { startDate: Date } => !!g.startDate && g.startDate.getTime() >= from && g.startDate.getTime() < until)
    .sort((a, b) => a.startDate.getTime() - b.startDate.getTime() || a.name.localeCompare(b.name))
    .map((g) => ({
      id: g.id,
      name: g.name,
      startDate: g.startDate,
      classSchedule: g.scheduleVisible ? (g.classSchedule ?? []) : [],
      format: g.format,
      language: g.language,
    }));
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const titles = (items: readonly ItemStub[], kind: ItemStub["kind"]) => items.filter((it) => it.kind === kind).map((it) => it.title);

/**
 * The only syllabus data the public page gets: an explicit pick from the published version's meta
 * and structure. Never ids, lesson or module descriptions, item content, materials, tasks, exams,
 * rules, grants, groups other than the upcoming ones, students or analytics.
 */
export function publicSyllabusView(input: {
  meta: Record<string, unknown>;
  structure: VersionStructure;
  details: ReadonlyMap<string, ModuleDetails>;
  timing: SyllabusTiming | null;
  teacher: { name: string; avatarUrl: string | null };
}) {
  const { meta, structure } = input;
  const timing = input.timing ?? emptyTiming();
  const blocks = withLegacyFallback(input.details, structure.modules);
  const modules = structure.modules.map((m) => {
    const details = blocks.get(m.id);
    return {
      title: m.title,
      position: m.position,
      duration: timing.modules[m.id] ?? null,
      details: hasModuleDetails(details) ? details : null,
      lessons: m.lessons.map((l) => ({ title: l.title, projects: titles(l.items, "STUDENT_PRACTICE") })),
      projects: titles(m.items, "STUDENT_PRACTICE"),
      assessments: titles(m.items, "ASSESSMENT"),
    };
  });
  return {
    title: str(meta.title),
    description: str(meta.description),
    subject: str(meta.subject),
    level: str(meta.level),
    language: str(meta.language),
    estimatedDurationLabel: str(meta.estimatedDurationLabel),
    estimatedHours: numOrNull(meta.estimatedHours),
    courseTiming: hasCourseTiming(timing.course) ? { duration: timing.course.duration, lessonsPerWeek: timing.course.lessonsPerWeek } : null,
    teacher: { name: input.teacher.name, avatarUrl: input.teacher.avatarUrl },
    moduleCount: modules.length,
    lessonCount: modules.reduce((n, m) => n + m.lessons.length, 0),
    modules,
    finalProjects: titles(structure.finalItems, "STUDENT_PRACTICE"),
    finalAssessments: titles(structure.finalItems, "ASSESSMENT"),
  };
}
export type PublicSyllabusView = ReturnType<typeof publicSyllabusView>;

/** Unique while a request is PENDING (NULL once decided), so one student has one open request per syllabus, type and group. */
export const openKeyOf = (r: { syllabusId: string; studentId: number; type: JoinRequestType; groupId: string | null }) =>
  `${r.syllabusId}:${r.studentId}:${r.type}:${r.groupId ?? ""}`;

/**
 * Why a new request must be refused, or null. GROUP needs one of the upcoming groups the page shows
 * (computed on the server, never trusted from the client) that the student is not in yet;
 * INDIVIDUAL is offered only while there is no upcoming group. The owner cannot request.
 */
export function joinRequestRejection(input: {
  type: JoinRequestType;
  groupId: string | null;
  isOwner: boolean;
  hasAccess: boolean;
  upcomingGroupIds: readonly string[];
  memberGroupIds: readonly string[];
}): AppErrorCode | null {
  if (input.isOwner) return "SYLLABUS_OWN_REQUEST";
  if (input.type === "GROUP") {
    if (!input.groupId || !input.upcomingGroupIds.includes(input.groupId)) return "JOIN_REQUEST_GROUP_UNAVAILABLE";
    if (input.memberGroupIds.includes(input.groupId)) return "ALREADY_MEMBER";
    return null;
  }
  if (input.groupId) return "JOIN_REQUEST_GROUP_UNAVAILABLE";
  if (input.upcomingGroupIds.length) return "JOIN_REQUEST_GROUP_AVAILABLE";
  if (input.hasAccess) return "SYLLABUS_ALREADY_HAS_ACCESS";
  return null;
}
