/**
 * What a syllabus means to its students right now, in the teacher's words. The builder always edits
 * a working copy; "publish" freezes it into a snapshot students learn from (they stay on the snapshot
 * they started with). Teachers see "who can see it" and "are my changes sent", never version numbers.
 */

export type SyllabusVisibility = "HIDDEN" | "READY" | "LIVE" | "ARCHIVED";
export type PublishAction = "PUBLISH" | "SEND_CHANGES" | "GRANT";

export interface PublishShape {
  currentVersionId: string | null;
  hasDraftChanges: boolean;
  archivedAt: Date | string | null;
}

/**
 * `activeGrants`: groups/students with access (active or starting later); null while unknown.
 * HIDDEN = never published; READY = published but nobody has access yet; LIVE = students can open it.
 */
export function publishState(s: PublishShape, activeGrants: number | null) {
  const published = !!s.currentVersionId;
  const archived = !!s.archivedAt;
  const visibility: SyllabusVisibility = archived ? "ARCHIVED" : !published ? "HIDDEN" : activeGrants === 0 ? "READY" : "LIVE";
  const unsentChanges = published && !archived && s.hasDraftChanges;
  const action: PublishAction | null = archived ? null : !published ? "PUBLISH" : unsentChanges ? "SEND_CHANGES" : activeGrants === 0 ? "GRANT" : null;
  return { visibility, unsentChanges, action, firstPublish: !published };
}

/**
 * What happens after the publish request succeeds: the groups/students to open it to (first publish
 * only, skipping those who already have access), and whether students already learning move to the
 * new snapshot (sending changes only).
 */
export function afterPublish(opts: {
  firstPublish: boolean;
  selectedGroupIds: readonly string[];
  grantedGroupIds: readonly string[];
  selectedStudentIds?: readonly number[];
  grantedStudentIds?: readonly number[];
  moveEnrolled: boolean;
  enrolled: number;
}) {
  const fresh = <T,>(selected: readonly T[] = [], granted: readonly T[] = []) => (opts.firstPublish ? [...new Set(selected)].filter((x) => !granted.includes(x)) : []);
  const grantGroupIds = fresh(opts.selectedGroupIds, opts.grantedGroupIds);
  const grantStudentIds = fresh(opts.selectedStudentIds, opts.grantedStudentIds);
  return {
    grantGroupIds,
    grantStudentIds,
    grant: grantGroupIds.length > 0 || grantStudentIds.length > 0,
    moveAll: !opts.firstPublish && opts.moveEnrolled && opts.enrolled > 0,
  };
}

type Counts = { added: number; removed: number; changed: number };
export interface DiffShape {
  modules: Counts;
  lessons: Counts;
  items: Counts;
  reordered: boolean;
  rulesChanged: boolean;
}

/** The diff as short plain phrases ("2 lessons edited, 1 module added"): message key suffixes under `pub.sum.` with counts. */
export function changeSummary(d: DiffShape): Array<{ key: string; count?: number }> {
  const parts: Array<{ key: string; count?: number }> = [];
  for (const what of ["modules", "lessons", "items"] as const)
    for (const how of ["added", "changed", "removed"] as const) if (d[what][how] > 0) parts.push({ key: `${what}.${how}`, count: d[what][how] });
  if (d.reordered) parts.push({ key: "reordered" });
  if (d.rulesChanged) parts.push({ key: "rulesChanged" });
  return parts;
}

/** Grants that give access now or later (the ones that make a syllabus "visible"). */
export const liveGrants = <G extends { state: string }>(grants: readonly G[] | undefined) => (grants ? grants.filter((g) => g.state === "ACTIVE" || g.state === "PENDING") : null);
