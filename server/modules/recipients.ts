import type { TaskAccessMode } from "../../drizzle/schema";
import type { TeacherScope } from "./access";
import { AppError } from "./errors";
import * as groups from "./groups";
import { rosterStudentIds } from "./taskAccess";

/**
 * Validates the recipients belong to this teacher and returns who they reach (group members only, for a GROUPS-restricted task).
 * `alreadyRecipients`: on edit, students already on the row (e.g. joined via the share link) may stay.
 */
export async function assertRecipients(scope: TeacherScope, groupIds: string[], studentIds: number[], accessMode: TaskAccessMode = "PUBLIC", alreadyRecipients: readonly number[] = []) {
  for (const g of groupIds) await groups.assertGroupOwner(scope, g);
  const own = new Set([...(await groups.teacherStudentIds(scope)), ...alreadyRecipients]);
  if (!studentIds.every((s) => own.has(s))) throw new AppError("FORBIDDEN");
  const fromGroups = await groups.activeStudentIdsOfGroups(groupIds);
  return rosterStudentIds({ accessMode, groupIds, studentIds }, fromGroups);
}

export function assertAccessGroups(accessMode: TaskAccessMode, groupIds: string[]) {
  if (accessMode === "GROUPS" && !groupIds.length) throw new AppError("TASK_GROUPS_REQUIRED");
}
