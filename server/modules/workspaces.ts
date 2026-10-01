import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { PROVIDER_TYPES, providerWorkspaces } from "../../drizzle/schema";
import type { TeachingCategory } from "../../shared/teachingCategories";
import { ENV } from "../_core/env";
import { requireDb } from "../db";
import { managedWorkspaces, type TeacherScope } from "./access";
import { AppError } from "./errors";

export const MAX_WORKSPACES_PER_USER = 5;

export type WorkspaceInput = {
  title: string;
  publicDisplayName: string;
  providerType: (typeof PROVIDER_TYPES)[number];
  teachingCategory: TeachingCategory;
  teachingSubcategory: string;
};

/**
 * Opening a teaching context never touches the user's learning memberships or other
 * workspaces: it only adds a Provider Workspace owned by this users.id.
 */
export async function createWorkspace(user: { id: number; email: string | null }, input: WorkspaceInput) {
  const allow = ENV.teacherEmailAllowlist;
  if (allow.length && !allow.includes((user.email ?? "").toLowerCase())) throw new AppError("WORKSPACE_NOT_ALLOWED");
  const db = requireDb();
  return db.transaction(async (tx) => {
    const owned = await managedWorkspaces(user.id, tx);
    if (owned.length >= MAX_WORKSPACES_PER_USER) throw new AppError("WORKSPACE_LIMIT");
    const id = nanoid();
    await tx.insert(providerWorkspaces).values({ id, ownerUserId: user.id, ...input });
    const [row] = await tx.select().from(providerWorkspaces).where(eq(providerWorkspaces.id, id)).limit(1);
    return row!;
  });
}

export async function updateWorkspace(scope: TeacherScope, patch: Partial<WorkspaceInput>) {
  const db = requireDb();
  if (Object.keys(patch).length) {
    await db.update(providerWorkspaces).set(patch).where(eq(providerWorkspaces.id, scope.workspaceId));
  }
  const [row] = await db.select().from(providerWorkspaces).where(eq(providerWorkspaces.id, scope.workspaceId)).limit(1);
  return row!;
}

export async function workspaceOwnerId(workspaceId: string) {
  const [row] = await requireDb()
    .select({ ownerUserId: providerWorkspaces.ownerUserId })
    .from(providerWorkspaces)
    .where(eq(providerWorkspaces.id, workspaceId))
    .limit(1);
  return row?.ownerUserId ?? null;
}
