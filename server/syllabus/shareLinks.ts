import { customAlphabet } from "nanoid";
import { SHARE_CODE_ALPHABET, SHARE_CODE_LENGTH } from "../../shared/syllabusJoin";
import type { TeacherScope } from "../modules/access";
import { AppError } from "../modules/errors";
import { assertGroupOwner } from "../modules/groups";
import { ownedSyllabus } from "./access";
import { grantState } from "./accessRules";
import * as joinStore from "./joinStore";
import { isShareable, selectUpcomingGroups } from "./joinRules";
import * as store from "./store";

/**
 * Teacher side of the public syllabus link: one unguessable code per syllabus, created the first
 * time the teacher copies it, separate from group invite codes. It only ever shows the published
 * version (see joinRequests.ts `publicSyllabus`) and grants no access to the syllabus itself.
 */

export const newShareCode = customAlphabet(SHARE_CODE_ALPHABET, SHARE_CODE_LENGTH);
const CODE_ATTEMPTS = 5;

export async function shareLinkState(scope: TeacherScope, syllabusId: string) {
  const syllabus = await ownedSyllabus(scope, syllabusId);
  const link = await joinStore.shareLinkOf(syllabusId);
  return { shareable: isShareable(syllabus), link: link ? { code: link.code, active: link.active } : null };
}

async function shareableSyllabus(scope: TeacherScope, syllabusId: string) {
  const syllabus = await ownedSyllabus(scope, syllabusId);
  if (syllabus.archivedAt || syllabus.status === "ARCHIVED") throw new AppError("SYLLABUS_ARCHIVED");
  if (!isShareable(syllabus)) throw new AppError("SYLLABUS_NOT_PUBLISHED");
  return syllabus;
}

/** Writes a fresh code, retrying on the (astronomically rare) collision with another syllabus' code. */
async function writeNewCode(scope: TeacherScope, syllabusId: string, exists: boolean): Promise<string> {
  for (let i = 0; i < CODE_ATTEMPTS; i++) {
    const code = newShareCode();
    try {
      if (exists) await joinStore.updateShareLink(syllabusId, { code, active: true });
      else await joinStore.insertShareLink({ syllabusId, code, createdBy: scope.userId });
      return code;
    } catch (error) {
      if (!joinStore.isDuplicateKey(error)) throw error;
      // Another request created this syllabus' link at the same moment: use theirs.
      if (!exists) {
        const raced = await joinStore.shareLinkOf(syllabusId);
        if (raced) return raced.code;
      }
    }
  }
  throw new Error("Could not generate a unique syllabus share code");
}

/** The link to copy: the existing one (also when turned off — the client says so), or a new active one. */
export async function ensureShareLink(scope: TeacherScope, syllabusId: string) {
  await shareableSyllabus(scope, syllabusId);
  const existing = await joinStore.shareLinkOf(syllabusId);
  if (existing) return { code: existing.code, active: existing.active };
  return { code: await writeNewCode(scope, syllabusId, false), active: true };
}

/** A new code; the old link stops working at once. */
export async function regenerateShareLink(scope: TeacherScope, syllabusId: string) {
  await shareableSyllabus(scope, syllabusId);
  const existing = await joinStore.shareLinkOf(syllabusId);
  return { code: await writeNewCode(scope, syllabusId, !!existing), active: true };
}

/** Turn the link off (the page answers 404) or back on with the same code. */
export async function setShareLinkActive(scope: TeacherScope, syllabusId: string, active: boolean) {
  if (active) await shareableSyllabus(scope, syllabusId);
  else await ownedSyllabus(scope, syllabusId);
  const existing = await joinStore.shareLinkOf(syllabusId);
  if (!existing) throw new AppError("NOT_FOUND");
  await joinStore.updateShareLink(syllabusId, { active });
  return { code: existing.code, active };
}

/**
 * Groups the teacher may offer on the share page: those holding a live grant for this syllabus,
 * with whether each is listed and whether it currently counts as upcoming.
 */
export async function groupListings(scope: TeacherScope, syllabusId: string, now = new Date()) {
  await ownedSyllabus(scope, syllabusId);
  const grants = await store.grantsForSyllabus(syllabusId);
  const liveGroupIds = [
    ...new Set(
      grants.flatMap((g) => {
        const state = grantState(g, now);
        return g.groupId && (state === "ACTIVE" || state === "PENDING") ? [g.groupId] : [];
      }),
    ),
  ];
  const [candidates, listed] = await Promise.all([joinStore.listingCandidates(liveGroupIds), joinStore.listedGroupIds(syllabusId)]);
  const own = candidates.filter((g) => g.workspaceId === scope.workspaceId);
  const upcoming = new Set(
    selectUpcomingGroups({ workspaceId: scope.workspaceId, candidates: own, listedGroupIds: own.map((g) => g.id), grants, now }).map((g) => g.id),
  );
  return own
    .map((g) => ({ groupId: g.id, name: g.name, startDate: g.startDate, listed: listed.includes(g.id), upcoming: upcoming.has(g.id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function setGroupListed(scope: TeacherScope, syllabusId: string, groupId: string, listed: boolean, now = new Date()) {
  await ownedSyllabus(scope, syllabusId);
  await assertGroupOwner(scope, groupId);
  if (listed) {
    const grants = await store.grantsForSyllabus(syllabusId);
    const live = grants.some((g) => g.groupId === groupId && ["ACTIVE", "PENDING"].includes(grantState(g, now)));
    if (!live) throw new AppError("SYLLABUS_INVALID_TARGET");
  }
  await joinStore.setListing(syllabusId, groupId, listed, scope.userId);
  return { groupId, listed };
}
