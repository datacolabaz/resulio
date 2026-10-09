import { nanoid } from "nanoid";
import { JOIN_DECISION_NOTE_MAX, JOIN_MESSAGE_MAX, normalizeShareCode, syllabusSharePath, type JoinDecision, type JoinRequestType } from "../../shared/syllabusJoin";
import type { TeacherScope } from "../modules/access";
import { AppError } from "../modules/errors";
import { activeGroupIdsOfStudent, addMemberById, assertGroupOwner } from "../modules/groups";
import { notifyOpenTasksOnJoin } from "../modules/taskNotify";
import { dispatch } from "../notifications/dispatcher";
import { syllabusPath as studentSyllabusPath } from "../notifications/templates";
import { grantFromJoinRequest, ownedSyllabus } from "./access";
import { effectiveGrant } from "./accessRules";
import { isSchemaBehind, syllabusEnabledFor } from "./availability";
import * as joinStore from "./joinStore";
import { isShareable, joinRequestRejection, openKeyOf, publicSyllabusView, selectUpcomingGroups } from "./joinRules";
import { announceGroupJoin } from "./notify";
import * as store from "./store";

/**
 * The public syllabus page and the join requests sent from it. The page and a request never give
 * access to the syllabus: an accepted GROUP request adds the student to the group (the group's
 * own grant then applies); an accepted INDIVIDUAL request opens it only when the teacher chooses
 * to grant individual access while accepting.
 */

export const requestDedupeKey = (requestId: string) => `syl-join-req:${requestId}`;
export const decisionDedupeKey = (requestId: string) => `syl-join-decided:${requestId}`;

/** The syllabus behind a share code, or NOT_FOUND for unknown, turned-off, unpublished, archived or feature-off. */
async function sharedSyllabus(rawCode: string) {
  const code = normalizeShareCode(rawCode);
  if (!code) throw new AppError("NOT_FOUND");
  const link = await joinStore.shareLinkByCode(code);
  if (!link?.active) throw new AppError("NOT_FOUND");
  const syllabus = await store.syllabusById(link.syllabusId);
  if (!syllabus || !isShareable(syllabus)) throw new AppError("NOT_FOUND");
  if (!(await syllabusEnabledFor(syllabus.providerWorkspaceId))) throw new AppError("NOT_FOUND");
  const teacher = await joinStore.teacherOfWorkspace(syllabus.providerWorkspaceId);
  if (!teacher) throw new AppError("NOT_FOUND");
  return { code, syllabus: { ...syllabus, currentVersionId: syllabus.currentVersionId }, teacher };
}

/** A page that cannot be served for a schema reason is simply not there for the public. */
async function publicGuard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isSchemaBehind(error)) throw new AppError("NOT_FOUND");
    throw error;
  }
}

async function upcomingFor(syllabus: { id: string; providerWorkspaceId: string }, now: Date) {
  const [grants, listed] = await Promise.all([store.grantsForSyllabus(syllabus.id), joinStore.listedGroupIds(syllabus.id)]);
  const candidates = await joinStore.listingCandidates(listed);
  return { grants, groups: selectUpcomingGroups({ workspaceId: syllabus.providerWorkspaceId, candidates, listedGroupIds: listed, grants, now }) };
}

/** What a signed-in visitor needs to know about themselves on this page; never anything about other people. */
async function viewerState(userId: number, ctx: { ownerUserId: number; grants: Awaited<ReturnType<typeof store.grantsForSyllabus>>; upcomingIds: string[] }, now: Date) {
  const isOwner = ctx.ownerUserId === userId;
  const activeGroupIds = await activeGroupIdsOfStudent(userId);
  return {
    isOwner,
    hasAccess: !isOwner && !!effectiveGrant(ctx.grants, userId, activeGroupIds, now),
    memberGroupIds: ctx.upcomingIds.filter((id) => activeGroupIds.includes(id)),
  };
}

export async function publicSyllabus(rawCode: string, userId: number | null, now = new Date()) {
  return publicGuard(async () => {
    const { code, syllabus, teacher } = await sharedSyllabus(rawCode);
    const version = await store.versionById(syllabus.currentVersionId);
    if (!version || version.version.status !== "PUBLISHED") throw new AppError("NOT_FOUND");
    const [details, timing, upcoming] = await Promise.all([
      store.moduleDetailsOfVersion(syllabus.currentVersionId),
      store.timingOfVersion(syllabus.currentVersionId),
      upcomingFor(syllabus, now),
    ]);
    const view = publicSyllabusView({ meta: version.version.meta, structure: version.structure, details, timing, teacher });
    const upcomingIds = upcoming.groups.map((g) => g.id);
    const viewer = userId === null ? null : await viewerOf(userId, syllabus.id, { ownerUserId: teacher.ownerUserId, grants: upcoming.grants, upcomingIds }, now);
    return { code, syllabus: view, groups: upcoming.groups, viewer };
  });
}

async function viewerOf(userId: number, syllabusId: string, ctx: Parameters<typeof viewerState>[1], now: Date) {
  const state = await viewerState(userId, ctx, now);
  return {
    ...state,
    requests: state.isOwner ? [] : await ownRequests(syllabusId, userId),
    // Only someone who can already open the syllabus (or its owner) learns its id, for the "open" button.
    syllabusId: state.hasAccess || state.isOwner ? syllabusId : null,
  };
}

async function ownRequests(syllabusId: string, studentId: number) {
  const rows = await joinStore.requestsOfStudentForSyllabus(syllabusId, studentId);
  const groupIds = [...new Set(rows.flatMap((r) => (r.groupId ? [r.groupId] : [])))];
  const names = new Map((await store.groupsByIds(groupIds)).map((g) => [g.id, g.name]));
  return rows.slice(0, 20).map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    groupId: r.groupId,
    groupName: r.groupId ? (names.get(r.groupId) ?? null) : null,
    message: r.message,
    decisionNote: r.decisionNote,
    createdAt: r.createdAt,
    decidedAt: r.decidedAt,
  }));
}

export interface JoinRequestInput {
  code: string;
  type: JoinRequestType;
  groupId: string | null;
  message: string;
}

/** Idempotent: asking again while a request is open returns that request (and notifies no one twice). */
export async function createJoinRequest(user: { id: number; name: string | null }, input: JoinRequestInput, now = new Date()) {
  const { syllabus, teacher } = await sharedSyllabus(input.code);
  const upcoming = await upcomingFor(syllabus, now);
  const upcomingIds = upcoming.groups.map((g) => g.id);
  const viewer = await viewerState(user.id, { ownerUserId: teacher.ownerUserId, grants: upcoming.grants, upcomingIds }, now);
  const groupId = input.type === "GROUP" ? input.groupId : null;
  const rejection = joinRequestRejection({ type: input.type, groupId: input.groupId, upcomingGroupIds: upcomingIds, ...viewer });
  if (rejection) throw new AppError(rejection);

  const openKey = openKeyOf({ syllabusId: syllabus.id, studentId: user.id, type: input.type, groupId });
  const existing = await joinStore.requestByOpenKey(openKey);
  if (existing) return { id: existing.id, status: existing.status, created: false };
  const id = nanoid();
  try {
    await joinStore.insertRequest({
      id,
      syllabusId: syllabus.id,
      workspaceId: syllabus.providerWorkspaceId,
      studentId: user.id,
      type: input.type,
      groupId,
      message: input.message.trim().slice(0, JOIN_MESSAGE_MAX),
      status: "PENDING",
      openKey,
    });
  } catch (error) {
    if (!joinStore.isDuplicateKey(error)) throw error;
    const raced = await joinStore.requestByOpenKey(openKey);
    if (raced) return { id: raced.id, status: raced.status, created: false };
    throw error;
  }
  dispatch({
    event: "SYLLABUS_JOIN_REQUESTED",
    userId: teacher.ownerUserId,
    dedupeKey: requestDedupeKey(id),
    data: {
      requestId: id,
      syllabusId: syllabus.id,
      syllabusTitle: syllabus.title,
      studentName: user.name,
      groupName: groupId ? (upcoming.groups.find((g) => g.id === groupId)?.name ?? null) : null,
    },
  });
  return { id, status: "PENDING" as const, created: true };
}

/** The student withdraws their own request while it is still pending. */
export async function cancelJoinRequest(userId: number, requestId: string) {
  const request = await joinStore.requestById(requestId);
  if (!request || request.studentId !== userId) throw new AppError("NOT_FOUND");
  if (!(await joinStore.closeRequest(requestId, { status: "CANCELLED", decidedBy: userId, decisionNote: null }))) throw new AppError("JOIN_REQUEST_NOT_PENDING");
  return { id: requestId, status: "CANCELLED" as const };
}

/** The student's own requests for the dashboard; the page link only while the share link is on. */
export async function myJoinRequests(userId: number) {
  const rows = await joinStore.requestsOfStudent(userId);
  return rows.map(({ shareCode, shareActive, ...r }) => ({ ...r, path: shareCode && shareActive ? syllabusSharePath(shareCode) : null }));
}

export async function syllabusJoinRequests(scope: TeacherScope, syllabusId: string) {
  await ownedSyllabus(scope, syllabusId);
  return joinStore.requestsOfSyllabus(syllabusId);
}

export async function joinRequestCounts(scope: TeacherScope) {
  return joinStore.pendingCountsOfWorkspace(scope.workspaceId);
}

/** Open requests of every syllabus this workspace owns (the "waiting requests" block on the syllabus list). */
export async function pendingJoinRequests(scope: TeacherScope) {
  return joinStore.pendingRequestsOfWorkspace(scope.workspaceId);
}

export interface DecideOptions {
  /** INDIVIDUAL only: also open the syllabus to the student with an individual grant. */
  grantAccess?: boolean;
}

/**
 * Accept or reject a pending request of this workspace. Accepting a GROUP request adds the student
 * to the group the same way "add student" does (open-task and syllabus notices included); if the
 * student is already a member it is just marked accepted. Accepting an INDIVIDUAL request is a
 * decision only unless the teacher asks to open the syllabus too. If the side effect fails the
 * request stays pending.
 */
export async function decideJoinRequest(scope: TeacherScope, requestId: string, decision: JoinDecision, rawNote: string | null, options: DecideOptions = {}) {
  const request = await joinStore.requestById(requestId);
  if (!request || request.workspaceId !== scope.workspaceId) throw new AppError("NOT_FOUND");
  const syllabus = await ownedSyllabus(scope, request.syllabusId);
  if (request.status !== "PENDING") throw new AppError("JOIN_REQUEST_NOT_PENDING");
  const note = rawNote?.trim().slice(0, JOIN_DECISION_NOTE_MAX) || null;
  const joinsGroup = decision === "ACCEPTED" && request.type === "GROUP" && !!request.groupId;
  const group = joinsGroup ? await assertGroupOwner(scope, request.groupId!) : null;
  const opensSyllabus = decision === "ACCEPTED" && request.type === "INDIVIDUAL" && !!options.grantAccess;
  if (opensSyllabus && syllabus.archivedAt) throw new AppError("SYLLABUS_ARCHIVED");

  if (!(await joinStore.closeRequest(requestId, { status: decision, decidedBy: scope.userId, decisionNote: note }))) throw new AppError("JOIN_REQUEST_NOT_PENDING");
  try {
    if (group) {
      try {
        await addMemberById(scope, group.id, request.studentId);
        notifyOpenTasksOnJoin(group.id, request.studentId);
        announceGroupJoin(group.id, request.studentId);
      } catch (error) {
        if (!(error instanceof AppError && error.code === "ALREADY_MEMBER")) throw error;
      }
    }
    if (opensSyllabus) await grantFromJoinRequest(scope, syllabus, request.studentId);
  } catch (error) {
    await joinStore.reopenRequest(request, openKeyOf(request));
    throw error;
  }

  const link = await joinStore.shareLinkOf(syllabus.id);
  const path = group ? "/student/groups" : opensSyllabus ? studentSyllabusPath(syllabus.id) : link?.active ? syllabusSharePath(link.code) : "/student";
  dispatch({
    event: "SYLLABUS_JOIN_DECIDED",
    userId: request.studentId,
    dedupeKey: decisionDedupeKey(requestId),
    data: {
      requestId,
      syllabusTitle: syllabus.title,
      decision,
      groupName: request.type === "GROUP" ? (group?.name ?? (request.groupId ? await joinStore.groupName(request.groupId) : null)) : null,
      note,
      path,
      accessGranted: opensSyllabus,
    },
  });
  return { id: requestId, status: decision, accessGranted: opensSyllabus };
}
